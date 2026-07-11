const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: ['https://ahmadswork.com', 'https://www.ahmadswork.com'], credentials: true }));
app.use(express.json());

// In-memory storage
const memStore = { conversations: [], messages: [], nextConvId: 1, nextMsgId: 1 };

function query(sql, params) {
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
    memStore.conversations = memStore.conversations.filter(c => c.id != params[0]); return [{}];
  }
  if (sql.includes('UPDATE conversations')) {
    const conv = memStore.conversations.find(c => c.id == params[0]);
    if (conv) conv.updatedAt = new Date(); return [{}];
  }
  return [[]];
}

async function generateAIResponse(userMsg, history) {
  const lower = userMsg.toLowerCase().trim();
  
  // Inappropriate content filter
  if (/(penis|sex|porn|nude|naked|kill|murder|terrorist|bomb|hack|crack|steal|illegal)/.test(lower)) {
    return "I'm designed to help with coding, tech, and career questions. Let's keep it professional! Ask me about JavaScript, React, Node.js, Python, or web development.";
  }
  
  // Coding help
  if (/(javascript|js|react|node|python|html|css|sql|bug|error|debug|function|variable|loop|array|object|api|database)/.test(lower)) {
    if (lower.includes('javascript') || lower.includes('js')) return "JavaScript powers the web! Start with variables (let/const), arrow functions, and async/await. The event loop is key to understanding how JS works. Want me to explain any of these?";
    if (lower.includes('react')) return "React is all about components and hooks. useState manages state, useEffect handles side effects. JSX lets you write HTML inside JavaScript. What React concept are you struggling with?";
    if (lower.includes('python')) return "Python reads like English — great for beginners! For data science: pandas + numpy. For web backends: FastAPI or Flask. For ML: scikit-learn + TensorFlow. What's your goal?";
    if (lower.includes('node')) return "Node.js runs JavaScript on the server. Use Express to build APIs, npm for packages, and connect to databases like MySQL or MongoDB. This very chat app uses Node.js + Express!";
    if (lower.includes('sql')) return "SQL is how you talk to databases. SELECT reads data, INSERT adds, UPDATE changes, DELETE removes. JOINs combine tables. Every web app needs database knowledge — practice writing real queries!";
    if (lower.includes('bug') || lower.includes('error') || lower.includes('debug')) return "Debugging is a superpower! 1) Read the error message twice. 2) Use console.log() to trace values. 3) Comment out code to isolate the issue. 4) Google the exact error. What's your error message?";
    if (lower.includes('api')) return "APIs let frontend and backend talk. REST APIs use GET (read), POST (create), PUT (update), DELETE (remove). This chat app uses a REST API to send messages to the server. Want to learn how to build one?";
    return "Great coding question! I can help with JavaScript, React, Node.js, Python, SQL, HTML/CSS, and more. What's the specific problem you're working on?";
  }
  
  // About the app
  if (/(who are you|what are you|what is this)/.test(lower)) return "I'm an AI assistant in this chat app. The app is built with: HTML/CSS/JS frontend (on Namecheap), Node.js + Express backend (on Vercel), and this smart response engine. It's a real full-stack project!";
  if (/(how.*work|tech stack|architecture|backend|frontend)/.test(lower)) return "Tech stack breakdown: Frontend = HTML/CSS/JS deployed on Namecheap. Backend = Node.js + Express on Vercel (serverless). API = REST with CORS. Storage = in-memory database. This is how real web apps are architected!";
  
  // Greetings
  if (/^(hi|hello|hey|yo|sup|howdy)/.test(lower)) return "Hey there! 👋 I'm your AI coding assistant. Ask me about JavaScript, React, Node.js, Python, SQL, web development, or tech careers!";
  
  // Career/learning
  if (/(career|job|interview|portfolio|hire|learn|study|degree)/.test(lower)) return "For tech careers: 1) Build projects like this chat app. 2) Deploy them with live links. 3) Put links on your resume. 4) Practice data structures on LeetCode. 5) Contribute to open source. This app alone proves full-stack skills!";
  
  // Thanks/goodbye
  if (/(thank|thanks)/.test(lower)) return "You're welcome! Happy coding! 🚀 Keep building and deploying!";
  if (/(bye|goodbye|see you|later)/.test(lower)) return "Goodbye! Your conversations are saved. Come back anytime and keep building cool stuff!";
  
  // Context-aware based on conversation length
  const convLength = history.length;
  if (convLength > 6) return "We've been chatting for a while! Based on our conversation, you're clearly interested in tech. What project are you building right now? I'd love to help.";
  if (convLength > 3) return "Got it! I'm here to help with coding questions, explain tech concepts, or give career advice. What would you like to dive into?";
  
  // Default
  return "I'm your AI assistant for this chat app! I can help with JavaScript, React, Node.js, Python, SQL, web development, and career advice. What would you like to talk about?";
}

// Routes
app.get('/api/rest/health', (req, res) => res.json({ ok: true }));

app.get('/api/rest/conversations/:userId', async (req, res) => { try { const [rows] = query('SELECT * FROM conversations WHERE userId = ? ORDER BY updatedAt DESC', [req.params.userId]); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/rest/conversations/:userId/:id', async (req, res) => { try { const [conv] = query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [req.params.id, req.params.userId]); if (!conv[0]) return res.status(404).json({ error: 'Not found' }); const [msgs] = query('SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt', [req.params.id]); res.json({ ...conv[0], messages: msgs }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/rest/conversations/:userId', async (req, res) => { try { const [result] = query('INSERT INTO conversations (userId, title, createdAt, updatedAt) VALUES (?, ?, NOW(), NOW())', [req.params.userId, req.body.title]); res.json({ id: result.insertId, userId: Number(req.params.userId), title: req.body.title, createdAt: new Date(), updatedAt: new Date() }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.delete('/api/rest/conversations/:userId/:id', async (req, res) => { try { query('DELETE FROM messages WHERE conversationId = ?', [req.params.id]); query('DELETE FROM conversations WHERE id = ?', [req.params.id]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/rest/messages/:userId', async (req, res) => { try { const { conversationId, content } = req.body; const [conv] = query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [conversationId, req.params.userId]); if (!conv[0]) return res.status(404).json({ error: 'Not found' }); query('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'user', content]); const [history] = query('SELECT role, content FROM messages WHERE conversationId = ? ORDER BY createdAt', [conversationId]); const aiContent = await generateAIResponse(content, history); const [result] = query('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'assistant', aiContent]); query('UPDATE conversations SET updatedAt = NOW() WHERE id = ?', [conversationId]); res.json({ messageId: result.insertId, content: aiContent, conversationId }); } catch (e) { res.status(500).json({ error: e.message }); } });

module.exports = app;
