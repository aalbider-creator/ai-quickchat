const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: ['https://ahmadswork.com', 'https://www.ahmadswork.com'], credentials: true }));
app.use(express.json());

// ===== CONFIG =====
const JWT_SECRET = process.env.JWT_SECRET || 'ahmad-dev-secret-key-2025';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CODE_EXPIRY_MS = 60 * 1000; // 60 seconds

const hasDB = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const hasOpenAI = !!OPENAI_API_KEY;

// ===== IN-MEMORY FALLBACK (when no DB) =====
const memStore = {
  users: [], conversations: [], messages: [],
  nextUserId: 1, nextConvId: 1, nextMsgId: 1
};
const conversationTopics = {};
const rateLimitMap = new Map(); // IP -> { count, resetAt }

// ===== JWT HELPERS =====
function jwtEncode(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function jwtDecode(token) {
  try {
    const [h, b, s] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
    if (s !== expected) return null;
    return JSON.parse(Buffer.from(b, 'base64url').toString());
  } catch { return null; }
}

// ===== PASSWORD =====
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + JWT_SECRET).digest('hex');
}

// ===== RATE LIMITING =====
function checkRateLimit(ip, maxAttempts = 5, windowMs = 60 * 1000) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  if (record.count >= maxAttempts) {
    const secondsLeft = Math.ceil((record.resetAt - now) / 1000);
    return { allowed: false, retryAfter: secondsLeft };
  }
  record.count++;
  return { allowed: true };
}

// ===== SUPABASE REST API HELPER =====
// Filter format: { column: 'value' } or { column: 'operator.value' }
// Examples: { email: 'test@test.com' } -> email=eq.test@test.com
//           { id: 'eq.0' } -> id=eq.0
async function dbQuery(table, action, options = {}) {
  if (!hasDB) return dbQueryMem(table, action, options);
  const { filter, body, method = 'GET', order, select = '*' } = options;
  const params = new URLSearchParams();
  params.set('select', select);
  if (filter) {
    for (const [key, val] of Object.entries(filter)) {
      params.set(key, val);
    }
  }
  if (order) params.set('order', order);
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`;
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json'
  };
  if (method === 'POST' || method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error URL:', url);
    console.error('Supabase error response:', err.substring(0, 500));
    throw new Error('DB error: URL=' + SUPABASE_URL.substring(0, 30) + '... Status=' + res.status);
  }
  const data = await res.json();
  return method === 'POST' && data[0] ? data[0] : data;
}

// ===== IN-MEMORY FALLBACK DB =====
async function dbQueryMem(table, action, options) {
  const { filter, body, method = 'GET', order } = options;
  if (table === 'users') {
    if (method === 'POST' && action === 'create') {
      const row = { id: memStore.nextUserId++, ...body, created_at: new Date().toISOString() };
      if (body.password_hash) row.password_hash = body.password_hash;
      memStore.users.push(row);
      return row;
    }
    if (method === 'PATCH' && action === 'update') {
      const parts = filter.split('.');
      const field = parts[0].replace('eq.', '');
      const val = parts[1] || filter.split('eq.')[1];
      const user = memStore.users.find(u => u.email === val || u.id == val);
      if (user) Object.assign(user, body);
      return user;
    }
    if (filter && filter.includes('eq.')) {
      const val = filter.split('eq.')[1];
      return memStore.users.filter(u => u.email === val || u.id == val);
    }
    return memStore.users;
  }
  if (table === 'conversations') {
    if (method === 'POST') {
      const row = { id: memStore.nextConvId++, ...body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      memStore.conversations.push(row); return row;
    }
    if (method === 'DELETE') {
      const convId = parseInt(filter.split('eq.')[1]);
      memStore.conversations = memStore.conversations.filter(c => c.id !== convId);
      memStore.messages = memStore.messages.filter(m => m.conversation_id !== convId);
      delete conversationTopics[convId];
      return { success: true };
    }
    if (method === 'PATCH') {
      const convId = parseInt(filter.split('eq.')[1]);
      const conv = memStore.conversations.find(c => c.id === convId);
      if (conv) { conv.updated_at = new Date().toISOString(); if (body.title) conv.title = body.title; }
      return conv;
    }
    if (filter) {
      const userId = parseInt(filter.split('eq.')[1]);
      let rows = memStore.conversations.filter(c => c.user_id === userId);
      if (order) rows = rows.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      return rows;
    }
    return memStore.conversations;
  }
  if (table === 'messages') {
    if (method === 'POST') {
      const row = { id: memStore.nextMsgId++, ...body, created_at: new Date().toISOString() };
      memStore.messages.push(row); return row;
    }
    if (filter) {
      const convId = parseInt(filter.split('eq.')[1]);
      return memStore.messages.filter(m => m.conversation_id === convId).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    return memStore.messages;
  }
  if (table === 'password_resets') {
    if (method === 'POST') {
      memStore.passwordResets = memStore.passwordResets || [];
      memStore.passwordResets.push({ ...body, created_at: new Date().toISOString() });
      return body;
    }
    if (filter) {
      memStore.passwordResets = memStore.passwordResets || [];
      const email = filter.split('eq.')[1];
      return memStore.passwordResets.filter(r => r.email === email);
    }
    return memStore.passwordResets || [];
  }
  return [];
}

// ===== EMAIL =====
async function sendEmail(to, subject, html) {
  if (RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'onboarding@resend.dev', to, subject, html })
      });
      const data = await res.json();
      if (!res.ok) return { error: data.message || JSON.stringify(data) };
      return { success: true };
    } catch (e) { return { error: e.message }; }
  }
  console.log('\n========== EMAIL (TEST MODE) ==========');
  console.log('To:', to);
  console.log('Subject:', subject);
  console.log('Code:', html.match(/\d{6}/)?.[0] || 'N/A');
  console.log('=======================================\n');
  return { success: true };
}

// ===== AUTH MIDDLEWARE =====
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  const decoded = jwtDecode(authHeader.substring(7));
  if (!decoded || !decoded.userId) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  req.userId = decoded.userId;
  req.email = decoded.email;
  next();
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

// ===== GROQ API (free, fast AI) =====
async function callGroq(userMsg, history) {
  const GROQ_KEY = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!GROQ_KEY) return null;
  try {
    const messages = [
      { role: 'system', content: 'You are a friendly, helpful AI assistant. Be conversational, engaging, and knowledgeable on any topic. Keep responses concise and under 150 words. Do not focus on coding unless asked.' }
    ];
    const recentHistory = history.slice(-10);
    for (const m of recentHistory) {
      messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: userMsg });

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 300,
        temperature: 0.7
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Groq error:', err.substring(0, 300));
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error('Groq fetch error:', e.message);
    return null;
  }
}

async function generateAIResponse(userMsg, history, conversationId) {
  const lower = userMsg.toLowerCase().trim();

  // Safety filter
  if (/(penis|sex|porn|nude|naked|kill|murder|terrorist|bomb|steal|illegal drugs)/.test(lower)) {
    return "I'm designed to help with coding, tech, and career questions. Let's keep it professional!";
  }

  // Try OpenAI first if configured
  if (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY) {
    const groqResponse = await callGroq(userMsg, history);
    if (groqResponse) return groqResponse;
  }

  // Fallback: rule-based responses
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
  if (convLength > 6) return "We've been chatting for a while! What else would you like to talk about?";
  return "Hey there! I'm your AI assistant — happy to chat about anything on your mind. What would you like to talk about?";
}

// ==========================================
// AUTH ROUTES
// ==========================================

// Helper: get client IP
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

// Step 1: Send verification code
app.post('/api/rest/auth/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    const ip = getClientIp(req);
    const limit = checkRateLimit(ip, 5, 60 * 1000);
    if (!limit.allowed) return res.status(429).json({ error: `Too many attempts. Try again in ${limit.retryAfter} seconds.` });

    if (!email) return res.status(400).json({ error: 'Email is required' });
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = crypto.createHash('sha256').update(code + JWT_SECRET).digest('hex');
    const verifyToken = jwtEncode({ email, codeHash, exp: Date.now() + CODE_EXPIRY_MS });

    const result = await sendEmail(email, 'Your Login Code - Ahmad\'s Portfolio',
      `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#0f0f11;color:#fafaf9;border-radius:8px;border:1px solid rgba(255,255,255,0.08)">
        <h2 style="color:#b45309;margin:0 0 8px;font-family:Georgia,serif">Ahmad's Portfolio</h2>
        <p style="color:#78716c;margin:0 0 24px;font-size:14px">Your verification code (expires in 60 seconds):</p>
        <div style="background:rgba(180,83,9,0.1);border:1px solid rgba(180,83,9,0.3);border-radius:6px;padding:16px;text-align:center;margin-bottom:24px">
          <span style="font-family:'JetBrains Mono',monospace;font-size:28px;letter-spacing:8px;color:#b45309;font-weight:600">${code}</span>
        </div>
        <p style="color:#78716c;font-size:12px;margin:0">This code expires in 60 seconds. If you didn't request this, ignore this email.</p>
      </div>`
    );

    if (result.error) {
      // Email failed but still give user the code on screen
      return res.json({ message: 'Email failed. Use this code:', verifyToken, testCode: code, emailFailed: true });
    }
    res.json({ message: 'Code sent! Check your email.', verifyToken });
  } catch (e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Step 2: Verify code
app.post('/api/rest/auth/verify-code', async (req, res) => {
  try {
    const { verifyToken, code } = req.body;
    if (!verifyToken || !code) return res.status(400).json({ error: 'Verification token and code are required' });

    const decoded = jwtDecode(verifyToken);
    if (!decoded) return res.status(400).json({ error: 'Invalid verification link. Please request a new code.' });
    if (Date.now() > decoded.exp) return res.status(400).json({ error: 'Code expired. Please request a new one.' });

    const codeHash = crypto.createHash('sha256').update(code + JWT_SECRET).digest('hex');
    if (codeHash !== decoded.codeHash) return res.status(400).json({ error: 'Incorrect code. Please try again.' });

    // Check if user already exists
    let users;
    try { users = await dbQuery('users', 'find', { filter: { email: 'eq.' + decoded.email } }); } catch { users = []; }
    const passwordToken = jwtEncode({ email: decoded.email, verified: true, exp: Date.now() + CODE_EXPIRY_MS });
    res.json({ message: 'Code verified!', passwordToken, hasAccount: users.length > 0 });
  } catch (e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Step 3: Set password (new account)
app.post('/api/rest/auth/set-password', async (req, res) => {
  try {
    const { passwordToken, password } = req.body;
    if (!passwordToken || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'Password too long' });

    const decoded = jwtDecode(passwordToken);
    if (!decoded || !decoded.verified) return res.status(400).json({ error: 'Invalid session. Please start over.' });
    if (Date.now() > decoded.exp) return res.status(400).json({ error: 'Session expired. Please start over.' });

    const email = decoded.email;
    const passwordHash = hashPassword(password);

    let user;
    try {
      const existing = await dbQuery('users', 'find', { filter: { email: 'eq.' + email } });
      if (existing.length > 0) {
        // Update existing user's password
        await dbQuery('users', 'update', { filter: { email: 'eq.' + email }, method: 'PATCH', body: { password_hash: passwordHash } });
        user = { id: existing[0].id, email };
      } else {
        // Create new user
        user = await dbQuery('users', 'create', { method: 'POST', body: { email, password_hash: passwordHash } });
      }
    } catch {
      // Fallback: create in memory
      const existing = memStore.users.find(u => u.email === email);
      if (existing) {
        existing.password_hash = passwordHash;
        user = { id: existing.id, email };
      } else {
        const row = { id: memStore.nextUserId++, email, password_hash: passwordHash, created_at: new Date().toISOString() };
        memStore.users.push(row);
        user = { id: row.id, email };
      }
    }

    const token = jwtEncode({ userId: user.id, email: user.email });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Login with email + password
app.post('/api/rest/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const ip = getClientIp(req);
    const limit = checkRateLimit(ip + ':login', 5, 60 * 1000);
    if (!limit.allowed) return res.status(429).json({ error: `Too many failed attempts. Try again in ${limit.retryAfter} seconds.` });

    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    let users;
    try { users = await dbQuery('users', 'find', { filter: { email: 'eq.' + email } }); } catch { users = []; }
    if (!users || users.length === 0) return res.status(401).json({ error: 'No account found with this email. Please sign up first.' });

    const passwordHash = hashPassword(password);
    const user = users[0];
    if (passwordHash !== user.password_hash) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

    const token = jwtEncode({ userId: user.id, email: user.email });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Forgot password: send reset code
app.post('/api/rest/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    let users;
    try { users = await dbQuery('users', 'find', { filter: { email: 'eq.' + email } }); } catch { users = []; }
    if (!users || users.length === 0) return res.status(404).json({ error: 'No account found with this email.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = crypto.createHash('sha256').update(code + JWT_SECRET).digest('hex');
    const resetToken = jwtEncode({ email, codeHash, exp: Date.now() + CODE_EXPIRY_MS });

    const result = await sendEmail(email, 'Password Reset - Ahmad\'s Portfolio',
      `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#0f0f11;color:#fafaf9;border-radius:8px;border:1px solid rgba(255,255,255,0.08)">
        <h2 style="color:#b45309;margin:0 0 8px;font-family:Georgia,serif">Password Reset</h2>
        <p style="color:#78716c;margin:0 0 24px;font-size:14px">Your password reset code (expires in 60 seconds):</p>
        <div style="background:rgba(180,83,9,0.1);border:1px solid rgba(180,83,9,0.3);border-radius:6px;padding:16px;text-align:center;margin-bottom:24px">
          <span style="font-family:'JetBrains Mono',monospace;font-size:28px;letter-spacing:8px;color:#b45309;font-weight:600">${code}</span>
        </div>
        <p style="color:#78716c;font-size:12px;margin:0">If you didn't request this, ignore this email.</p>
      </div>`
    );

    if (result.error) {
      return res.json({ message: 'Email failed. Use this code:', resetToken, testCode: code, emailFailed: true });
    }
    res.json({ message: 'Reset code sent! Check your email.', resetToken });
  } catch (e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Reset password with code
app.post('/api/rest/auth/reset-password', async (req, res) => {
  try {
    const { resetToken, code, password } = req.body;
    if (!resetToken || !code || !password) return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const decoded = jwtDecode(resetToken);
    if (!decoded) return res.status(400).json({ error: 'Invalid token. Please request a new code.' });
    if (Date.now() > decoded.exp) return res.status(400).json({ error: 'Code expired. Please request a new one.' });

    const codeHash = crypto.createHash('sha256').update(code + JWT_SECRET).digest('hex');
    if (codeHash !== decoded.codeHash) return res.status(400).json({ error: 'Incorrect code. Please try again.' });

    const passwordHash = hashPassword(password);
    try {
      await dbQuery('users', 'update', { filter: { email: 'eq.' + decoded.email }, method: 'PATCH', body: { password_hash: passwordHash } });
    } catch {
      const user = memStore.users.find(u => u.email === decoded.email);
      if (user) user.password_hash = passwordHash;
    }

    res.json({ message: 'Password updated! You can now log in.' });
  } catch (e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Change password (logged in)
app.post('/api/rest/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    let users;
    try { users = await dbQuery('users', 'find', { filter: { id: 'eq.' + req.userId } }); } catch { users = []; }
    if (!users || users.length === 0) return res.status(404).json({ error: 'User not found' });

    const currentHash = hashPassword(currentPassword);
    if (currentHash !== users[0].password_hash) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = hashPassword(newPassword);
    try {
      await dbQuery('users', 'update', { filter: { id: 'eq.' + req.userId }, method: 'PATCH', body: { password_hash: newHash } });
    } catch {
      const user = memStore.users.find(u => u.id === req.userId);
      if (user) user.password_hash = newHash;
    }
    res.json({ message: 'Password changed successfully' });
  } catch (e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Delete account
app.delete('/api/rest/auth/account', authMiddleware, async (req, res) => {
  try {
    // Delete user's conversations and messages
    try {
      const convs = await dbQuery('conversations', 'find', { filter: { user_id: 'eq.' + req.userId } });
      for (const c of convs) {
        await dbQuery('messages', 'delete', { filter: { conversation_id: 'eq.' + c.id }, method: 'DELETE' });
      }
      await dbQuery('conversations', 'delete', { filter: { user_id: 'eq.' + req.userId }, method: 'DELETE' });
      await dbQuery('users', 'delete', { filter: { id: 'eq.' + req.userId }, method: 'DELETE' });
    } catch {
      memStore.conversations = memStore.conversations.filter(c => c.user_id !== req.userId);
      memStore.messages = memStore.messages.filter(m => {
        const conv = memStore.conversations.find(c => c.id === m.conversation_id);
        return conv;
      });
      memStore.users = memStore.users.filter(u => u.id !== req.userId);
    }
    res.json({ message: 'Account deleted' });
  } catch (e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Get current user
app.get('/api/rest/auth/me', authMiddleware, async (req, res) => {
  res.json({ id: req.userId, email: req.email });
});

// ==========================================
// CHAT ROUTES
// ==========================================

// Health check - shows DB connection status
app.get('/api/rest/health', async (req, res) => {
  let dbStatus = 'disabled';
  if (hasDB) {
    try {
      const test = await dbQuery('users', 'find', { filter: { id: 'eq.0' } });
      dbStatus = 'connected';
    } catch (e) { dbStatus = 'error: ' + e.message; }
  }
  const groqKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  res.json({ ok: true, auth: true, db: hasDB, dbStatus, ai: !!groqKey, aiType: groqKey ? 'groq' : 'none', envVars: { url: !!SUPABASE_URL, key: !!SUPABASE_ANON_KEY, ai_key: !!groqKey } });
});

app.get('/api/rest/test-ai', async (req, res) => {
  const key = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return res.json({ error: 'No GROQ_API_KEY or OPENAI_API_KEY set' });
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{role:'user',content:'Say "Groq AI is working!"'}], max_tokens: 20 })
    });
    const data = await r.json();
    res.json({ status: r.status, ok: r.ok, response: data });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/rest/conversations', authMiddleware, async (req, res) => {
  try {
    const rows = await dbQuery('conversations', 'find', { filter: { user_id: 'eq.' + req.userId }, order: 'updated_at.desc' });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Failed to load conversations' }); }
});

app.get('/api/rest/conversations/:id', authMiddleware, async (req, res) => {
  try {
    const convs = await dbQuery('conversations', 'find', { filter: { id: 'eq.' + req.params.id } });
    if (!convs || convs.length === 0 || convs[0].user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
    const msgs = await dbQuery('messages', 'find', { filter: { conversation_id: 'eq.' + req.params.id }, order: 'created_at.asc' });
    res.json({ ...convs[0], messages: msgs });
  } catch (e) { res.status(500).json({ error: 'Failed to load conversation' }); }
});

app.post('/api/rest/conversations', authMiddleware, async (req, res) => {
  try {
    const result = await dbQuery('conversations', 'create', { method: 'POST', body: { user_id: req.userId, title: req.body.title || 'New Chat' } });
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'Failed to create conversation' }); }
});

app.delete('/api/rest/conversations/:id', authMiddleware, async (req, res) => {
  try {
    await dbQuery('conversations', 'delete', { filter: { id: 'eq.' + req.params.id }, method: 'DELETE' });
    delete conversationTopics[req.params.id];
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete conversation' }); }
});

app.post('/api/rest/messages', authMiddleware, async (req, res) => {
  try {
    const { conversationId, content } = req.body;
    const convs = await dbQuery('conversations', 'find', { filter: { id: 'eq.' + conversationId } });
    if (!convs || convs.length === 0 || convs[0].user_id !== req.userId) return res.status(404).json({ error: 'Conversation not found' });

    await dbQuery('messages', 'create', { method: 'POST', body: { conversation_id: conversationId, role: 'user', content } });
    const history = await dbQuery('messages', 'find', { filter: { conversation_id: 'eq.' + conversationId } });
    const aiContent = await generateAIResponse(content, history, conversationId);
    // Small delay ensures AI message has later timestamp than user message
    await new Promise(r => setTimeout(r, 50));
    const result = await dbQuery('messages', 'create', { method: 'POST', body: { conversation_id: conversationId, role: 'assistant', content: aiContent } });
    await dbQuery('conversations', 'update', { filter: { id: 'eq.' + conversationId }, method: 'PATCH', body: { updated_at: new Date().toISOString() } });

    res.json({ messageId: result.id, content: aiContent, conversationId });
  } catch (e) { res.status(500).json({ error: 'Failed to send message' }); }
});

module.exports = app;
