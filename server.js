const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: ['https://ahmadswork.com', 'https://www.ahmadswork.com'], credentials: true }));
app.use(express.json());

// ===== AUTH UTILITIES =====
const JWT_SECRET = process.env.JWT_SECRET || 'ahmad-dev-secret-key-2025';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + JWT_SECRET).digest('hex');
}

function generateToken(userId, email) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ userId, email, iat: Date.now() })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, payload, signature] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    if (signature !== expectedSig) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data;
  } catch { return null; }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  req.userId = decoded.userId;
  req.email = decoded.email;
  next();
}

// ===== IN-MEMORY STORAGE =====
const memStore = {
  users: [],       // { id, email }
  conversations: [],
  messages: [],
  nextUserId: 1,
  nextConvId: 1,
  nextMsgId: 1
};
const conversationTopics = {};

// ===== EMAIL VERIFICATION CODES =====
// { email: { code, expiresAt } }
const verificationCodes = {};
const CODE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}

function cleanupExpiredCodes() {
  const now = Date.now();
  for (const email of Object.keys(verificationCodes)) {
    if (verificationCodes[email].expiresAt < now) {
      delete verificationCodes[email];
    }
  }
}

async function sendEmail(to, subject, html) {
  // If Resend API key is configured, use it
  if (RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'onboarding@resend.dev',
          to,
          subject,
          html
        })
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('Resend error:', JSON.stringify(data));
        return { error: data.message || JSON.stringify(data) };
      }
      return { success: true };
    } catch (e) {
      console.error('Email send error:', e);
      return false;
    }
  }
  // Fallback: log to console for testing
  console.log('\n========== EMAIL (TEST MODE - No API Key) ==========');
  console.log('To:', to);
  console.log('Subject:', subject);
  console.log('Body:', html.replace(/<[^>]*>/g, ''));
  console.log('=====================================================\n');
  return true;
}

// ===== QUERY HELPER =====
function query(sql, params) {
  if (sql.includes('users WHERE email =')) {
    return [memStore.users.filter(u => u.email === params[0])];
  }
  if (sql.includes('users WHERE id =')) {
    return [memStore.users.filter(u => u.id == params[0])];
  }
  if (sql.includes('INSERT INTO users')) {
    const row = { id: memStore.nextUserId++, email: params[0] };
    memStore.users.push(row);
    return [{ insertId: row.id }];
  }
  if (sql.includes('conversations WHERE userId =')) {
    return [memStore.conversations.filter(c => c.userId == params[0]).sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt))];
  }
  if (sql.includes('conversations WHERE id = ? AND userId =')) {
    return [memStore.conversations.filter(c => c.id == params[0] && c.userId == params[1])];
  }
  if (sql.includes('messages WHERE conversationId = ? ORDER BY createdAt')) {
    return [memStore.messages.filter(m => m.conversationId == params[0]).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))];
  }
  if (sql.includes('role, content FROM messages')) {
    return [memStore.messages.filter(m => m.conversationId == params[0]).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))];
  }
  if (sql.includes('INSERT INTO conversations')) {
    const row = { id: memStore.nextConvId++, userId: params[0], title: params[1], createdAt: new Date(), updatedAt: new Date() };
    memStore.conversations.push(row); return [{ insertId: row.id }];
  }
  if (sql.includes('INSERT INTO messages')) {
    const row = { id: memStore.nextMsgId++, conversationId: params[0], role: params[1], content: params[2], createdAt: new Date() };
    memStore.messages.push(row); return [{ insertId: row.id }];
  }
  if (sql.includes('DELETE FROM messages')) {
    memStore.messages = memStore.messages.filter(m => m.conversationId != params[0]); return [{}];
  }
  if (sql.includes('DELETE FROM conversations')) {
    memStore.conversations = memStore.conversations.filter(c => c.id != params[0]);
    delete conversationTopics[params[0]];
    return [{}];
  }
  if (sql.includes('UPDATE conversations')) {
    const conv = memStore.conversations.find(c => c.id == params[0]);
    if (conv) conv.updatedAt = new Date(); return [{}];
  }
  return [[]];
}

// ===== AI RESPONSE ENGINE =====
function detectTopic(msg) {
  const lower = msg.toLowerCase();
  if (/(javascript|js|es6|typescript|ts|node|npm|webpack|babel)/.test(lower)) return 'javascript';
  if (/(react|jsx|hooks|usestate|useeffect|redux|next\.?js)/.test(lower)) return 'react';
  if (/(python|pandas|numpy|flask|fastapi|django|pip)/.test(lower)) return 'python';
  if (/(sql|mysql|postgres|database|query|select|insert)/.test(lower)) return 'sql';
  if (/(html|css|tailwind|bootstrap|flexbox|grid)/.test(lower)) return 'frontend';
  if (/(api|rest|express|server|endpoint|route|middleware)/.test(lower)) return 'backend';
  if (/(git|github|deploy|vercel|hosting|docker)/.test(lower)) return 'devops';
  if (/(career|job|interview|resume|portfolio|hire)/.test(lower)) return 'career';
  return null;
}

async function generateAIResponse(userMsg, history, conversationId) {
  const lower = userMsg.toLowerCase().trim();
  if (/(penis|sex|porn|nude|naked|kill|murder|terrorist|bomb|steal|illegal drugs)/.test(lower)) {
    return "I'm designed to help with coding, tech, and career questions. Let's keep it professional!";
  }
  const detectedTopic = detectTopic(userMsg);
  if (detectedTopic) conversationTopics[conversationId] = detectedTopic;
  const topic = conversationTopics[conversationId];
  const recentUserMsgs = history.filter(m => m.role === 'user').slice(-3).map(m => m.content.toLowerCase());
  if (topic === 'javascript' || recentUserMsgs.some(m => /(javascript|js)/.test(m))) {
    if (/(arrow function|=>)/.test(lower)) return "Arrow functions: `const add = (a, b) => a + b;`\n\n- Shorter syntax, no own 'this', great for callbacks.";
    if (/(async|await|promise)/.test(lower)) return "Async/await handles async code cleanly. `async` makes a function return a Promise, `await` pauses until it resolves.";
    if (/(let|const|var)/.test(lower)) return "`const` = block-scoped, can't reassign (use by default). `let` = block-scoped, can reassign. `var` = function-scoped (AVOID).";
    return "JavaScript powers the web — runs in browsers and servers (via Node.js). Ask about variables, functions, async/await, or the DOM!";
  }
  if (topic === 'react' || recentUserMsgs.some(m => /(react|jsx|hooks)/.test(m))) {
    if (/(usestate|state)/.test(lower)) return "`useState` adds state to functional components. Returns [value, setter]. State changes trigger re-renders.";
    if (/(useeffect|effect)/.test(lower)) return "`useEffect` handles side effects like API calls. Empty deps `[]` = run once. Return a cleanup function.";
    return "React uses components, JSX, props, and hooks (useState, useEffect). What React topic do you want to explore?";
  }
  if (topic === 'python' || recentUserMsgs.some(m => /(python|pandas|flask)/.test(m))) {
    if (/(flask|fastapi|django)/.test(lower)) return "Flask = lightweight, FastAPI = modern + fast, Django = full-featured. For APIs, I recommend FastAPI.";
    return "Python is great for data science, web backends, and scripting. What do you want to build?";
  }
  if (topic === 'sql' || recentUserMsgs.some(m => /(sql|database|query|mysql)/.test(m))) {
    if (/(join|inner|left|right)/.test(lower)) return "INNER JOIN = matching rows only. LEFT JOIN = all from left table + matching from right. Essential for combining data.";
    return "SQL: SELECT (read), INSERT (add), UPDATE (change), DELETE (remove). Every web app needs database knowledge.";
  }
  if (/^(hi|hello|hey|yo|sup)/.test(lower)) return "Hey there! Ask me about JavaScript, React, Node.js, Python, SQL, web development, or tech careers!";
  if (/(who are you|what are you|what is this)/.test(lower)) return "I'm an AI assistant. This chat app is built with Node.js + Express backend on Vercel, HTML/CSS/JS frontend on Namecheap.";
  if (/(how.*work|tech stack|architecture)/.test(lower)) return "Tech stack: Frontend = HTML/CSS/JS on Namecheap. Backend = Node.js + Express on Vercel. API = REST with CORS. Auth = JWT tokens + email verification.";
  if (/(thank|thanks)/.test(lower)) return "You're welcome! Happy coding!";
  if (/(bye|goodbye)/.test(lower)) return "Goodbye! Your conversations are saved. Come back anytime!";
  const convLength = history.length;
  if (convLength > 6) return "We've been chatting for a while! What project are you building? I can help with specific problems.";
  return "I'm your AI assistant! I can help with JavaScript, React, Node.js, Python, SQL, web development, and career advice. What would you like to talk about?";
}

// ===== EMAIL VERIFICATION AUTH ROUTES =====

// Step 1: Request verification code
app.post('/api/rest/auth/send-code', async (req, res) => {
  try {
    cleanupExpiredCodes();
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });

    const code = generateCode();
    verificationCodes[email] = { code, expiresAt: Date.now() + CODE_EXPIRY_MS };

    const emailSent = await sendEmail(
      email,
      'Your Login Code for Ahmad\'s Portfolio',
      `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#0f0f11;color:#fafaf9;border-radius:8px;border:1px solid rgba(255,255,255,0.08)">
        <h2 style="color:#b45309;margin:0 0 8px;font-family:Georgia,serif">Ahmad's Portfolio</h2>
        <p style="color:#78716c;margin:0 0 24px;font-size:14px">Use this code to sign in:</p>
        <div style="background:rgba(180,83,9,0.1);border:1px solid rgba(180,83,9,0.3);border-radius:6px;padding:16px;text-align:center;margin-bottom:24px">
          <span style="font-family:'JetBrains Mono',monospace;font-size:28px;letter-spacing:8px;color:#b45309;font-weight:600">${code}</span>
        </div>
        <p style="color:#78716c;font-size:12px;margin:0">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
      </div>`
    );

    if (!emailSent || emailSent.error) {
      // Don't expose the code in production if email fails
      if (RESEND_API_KEY) return res.status(500).json({ error: emailSent.error || 'Failed to send email. Try again.' });
      // In test mode, return the code so user can see it
      return res.json({ message: 'Code generated (test mode - check server logs)', testCode: code });
    }

    res.json({ message: 'Check your email for the login code' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 2: Verify code and log in
app.post('/api/rest/auth/verify-code', async (req, res) => {
  try {
    cleanupExpiredCodes();
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

    const record = verificationCodes[email];
    if (!record) return res.status(400).json({ error: 'Code expired or not found. Please request a new one.' });
    if (record.code !== code) return res.status(400).json({ error: 'Invalid code. Please try again.' });

    // Code verified — find or create user
    let [users] = query('SELECT * FROM users WHERE email = ?', [email]);
    let user;
    if (users.length === 0) {
      const [result] = query('INSERT INTO users (email) VALUES (?)', [email]);
      user = { id: result.insertId, email };
    } else {
      user = users[0];
    }

    // Clear the used code
    delete verificationCodes[email];

    const token = generateToken(user.id, user.email);
    res.json({ token, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get current user
app.get('/api/rest/auth/me', authMiddleware, (req, res) => {
  res.json({ id: req.userId, email: req.email });
});

// ===== CHAT ROUTES (protected by auth) =====

app.get('/api/rest/health', (req, res) => res.json({ ok: true, auth: true }));

app.get('/api/rest/conversations', authMiddleware, async (req, res) => {
  try { const [rows] = query('SELECT * FROM conversations WHERE userId = ? ORDER BY updatedAt DESC', [req.userId]); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rest/conversations/:id', authMiddleware, async (req, res) => {
  try {
    const [conv] = query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [req.params.id, req.userId]);
    if (!conv[0]) return res.status(404).json({ error: 'Not found' });
    const [msgs] = query('SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt', [req.params.id]);
    res.json({ ...conv[0], messages: msgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rest/conversations', authMiddleware, async (req, res) => {
  try {
    const [result] = query('INSERT INTO conversations (userId, title, createdAt, updatedAt) VALUES (?, ?, NOW(), NOW())', [req.userId, req.body.title]);
    res.json({ id: result.insertId, userId: req.userId, title: req.body.title, createdAt: new Date(), updatedAt: new Date() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/rest/conversations/:id', authMiddleware, async (req, res) => {
  try {
    query('DELETE FROM messages WHERE conversationId = ?', [req.params.id]);
    query('DELETE FROM conversations WHERE id = ?', [req.params.id]);
    delete conversationTopics[req.params.id];
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rest/messages', authMiddleware, async (req, res) => {
  try {
    const { conversationId, content } = req.body;
    const [conv] = query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [conversationId, req.userId]);
    if (!conv[0]) return res.status(404).json({ error: 'Not found' });

    query('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'user', content]);
    const [history] = query('SELECT role, content FROM messages WHERE conversationId = ? ORDER BY createdAt', [conversationId]);
    const aiContent = await generateAIResponse(content, history, conversationId);
    const [result] = query('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'assistant', aiContent]);
    query('UPDATE conversations SET updatedAt = NOW() WHERE id = ?', [conversationId]);

    res.json({ messageId: result.insertId, content: aiContent, conversationId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
