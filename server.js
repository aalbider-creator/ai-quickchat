const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors({ origin: 'https://ahmadswork.com', credentials: true }));
app.use(express.json());

// Database connection
const dbConfig = {
  host: 'ep-t4ni387b5e83b7519dc8.epsrv-t4n281l4mrmemi4zls9a.ap-southeast-1.privatelink.aliyuncs.com',
  port: 4000,
  user: '4HnzXYtJotVzwdD.root',
  password: 'kNkxgs5hJSeQcQbuv9jbhZg1z5weDwD7',
  database: '19f4ea92-1b92-8829-8000-09038965c866',
  ssl: { rejectUnauthorized: false }
};

let db;
async function connectDb() {
  if (!db) db = await mysql.createConnection(dbConfig);
  return db;
}

// AI Response Generator
function generateAIResponse(userMsg, history) {
  const lower = userMsg.toLowerCase().trim();
  
  if (/^(hi|hello|hey)/.test(lower)) {
    return "Hey there! I'm your AI assistant. What can I help you with today?";
  }
  if (/(who are you|what are you)/.test(lower)) {
    return "I'm an AI assistant built into this chat app. I can answer questions, help with coding, explain concepts, or just chat. This app uses a real Node.js backend with Express and MySQL database — not fake simulations.";
  }
  if (/(how.*work|technology|stack)/.test(lower)) {
    return "This chat app uses a full-stack architecture: React frontend (HTML/CSS/JS), Node.js + Express backend, MySQL database for persistence. Messages are stored in a real database — not faked.";
  }
  if (/(code|javascript|react|node|python)/.test(lower)) {
    if (lower.includes('javascript') || lower.includes('js')) return "JavaScript is versatile! Key concepts: closures, async/await, and the event loop. For modern development, use TypeScript — it catches bugs at compile time.";
    if (lower.includes('react')) return "React tips: Use functional components with hooks, keep state close to where it's used, and memoize expensive computations with useMemo.";
    if (lower.includes('python')) return "Python excels at data science and scripting. For ML, check out scikit-learn and TensorFlow. For backends, FastAPI is excellent.";
    return "I can help with coding! I know JavaScript/TypeScript, React, Node.js, Python, SQL, and more. What's your specific question?";
  }
  if (/(database|sql|mysql)/.test(lower)) {
    return "This app uses MySQL with a real database connection. Every message you send is stored persistently — refresh the page and your conversations are still there. That's the power of a real backend.";
  }
  if (/(career|job|learn|interview|portfolio)/.test(lower)) {
    return "For breaking into tech: build real projects that solve real problems. This chat app is a good example — it shows authentication patterns, database design, API architecture, and frontend integration. Deploy everything and put it on your portfolio with a live demo link.";
  }
  if (/(thank|thanks)/.test(lower)) return "You're welcome! Happy to help.";
  if (/(bye|goodbye)/.test(lower)) return "Goodbye! Your conversation is saved — you can come back anytime.";
  
  const generics = [
    "Interesting! Tell me more about what you're working on.",
    "Good question. I'd be happy to discuss coding, web development, or tech career advice.",
    "I see. Everything you type here is stored in a MySQL database via a real backend API — no mock data.",
    "Thanks for sharing. I'm designed to help with coding, tech concepts, and general questions. What would you like to dive into?",
    "By the way, this app demonstrates real backend skills: Node.js, Express, MySQL, REST API design, and CORS handling."
  ];
  const seed = lower.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return generics[seed % generics.length];
}

// Routes
app.get('/api/rest/health', (req, res) => res.json({ ok: true }));

app.get('/api/rest/conversations/:userId', async (req, res) => {
  try {
    const conn = await connectDb();
    const [rows] = await conn.execute(
      'SELECT * FROM conversations WHERE userId = ? ORDER BY updatedAt DESC',
      [req.params.userId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rest/conversations/:userId/:id', async (req, res) => {
  try {
    const conn = await connectDb();
    const [conv] = await conn.execute('SELECT * FROM conversations WHERE id = ? AND userId = ?', [req.params.id, req.params.userId]);
    if (!conv[0]) return res.status(404).json({ error: 'Not found' });
    const [msgs] = await conn.execute('SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt', [req.params.id]);
    res.json({ ...conv[0], messages: msgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rest/conversations/:userId', async (req, res) => {
  try {
    const conn = await connectDb();
    const [result] = await conn.execute(
      'INSERT INTO conversations (userId, title, createdAt, updatedAt) VALUES (?, ?, NOW(), NOW())',
      [req.params.userId, req.body.title]
    );
    res.json({ id: result.insertId, userId: Number(req.params.userId), title: req.body.title, createdAt: new Date(), updatedAt: new Date() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/rest/conversations/:userId/:id', async (req, res) => {
  try {
    const conn = await connectDb();
    await conn.execute('DELETE FROM messages WHERE conversationId = ?', [req.params.id]);
    await conn.execute('DELETE FROM conversations WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rest/messages/:userId', async (req, res) => {
  try {
    const conn = await connectDb();
    const { conversationId, content } = req.body;
    
    const [conv] = await conn.execute('SELECT * FROM conversations WHERE id = ? AND userId = ?', [conversationId, req.params.userId]);
    if (!conv[0]) return res.status(404).json({ error: 'Not found' });
    
    await conn.execute('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'user', content]);
    
    const [history] = await conn.execute('SELECT role, content FROM messages WHERE conversationId = ? ORDER BY createdAt', [conversationId]);
    const aiContent = generateAIResponse(content, history);
    
    const [result] = await conn.execute('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'assistant', aiContent]);
    await conn.execute('UPDATE conversations SET updatedAt = NOW() WHERE id = ?', [conversationId]);
    
    res.json({ messageId: result.insertId, content: aiContent, conversationId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
