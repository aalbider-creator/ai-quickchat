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

function generateAIResponse(userMsg, history) {
  const lower = userMsg.toLowerCase().trim();
  if (/^(hi|hello|hey)/.test(lower)) return "Hey there! I'm your AI assistant. What can I help you with today?";
  if (/(who are you|what are you)/.test(lower)) return "I'm an AI assistant. This app uses a real Node.js backend with Express — not fake simulations.";
  if (/(how.*work|technology|stack)/.test(lower)) return "Full-stack: HTML/CSS/JS frontend, Node.js + Express backend. Messages persist via REST API.";
  if (/(code|javascript|react|node|python)/.test(lower)) {
    if (lower.includes('javascript') || lower.includes('js')) return "JavaScript tips: closures, async/await, event loop. Use TypeScript to catch bugs early.";
    if (lower.includes('react')) return "React: functional components + hooks, keep state local, useMemo for expensive calcs.";
    if (lower.includes('python')) return "Python: great for data science. Check scikit-learn, TensorFlow, FastAPI for backends.";
    return "I can help with JavaScript, TypeScript, React, Node.js, Python, SQL. What's your question?";
  }
  if (/(database|sql|mysql)/.test(lower)) return "Every message persists — refresh and conversations are still there. Real backend power.";
  if (/(career|job|learn|interview|portfolio)/.test(lower)) return "Build real projects. This chat app shows: database design, API architecture, frontend integration.";
  if (/(thank|thanks)/.test(lower)) return "You're welcome! Happy to help.";
  if (/(bye|goodbye)/.test(lower)) return "Goodbye! Your conversation is saved — come back anytime.";
  const generics = ["Interesting! Tell me more.", "Good question. I can discuss coding, web dev, or career advice.", "Everything here goes through a real backend API.", "I'm designed for coding help and tech questions. What would you like to explore?", "This app shows: Node.js, Express, REST API design, CORS handling."];
  return generics[lower.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % generics.length];
}

// Routes
app.get('/api/rest/health', (req, res) => res.json({ ok: true }));

app.get('/api/rest/conversations/:userId', async (req, res) => { try { const [rows] = query('SELECT * FROM conversations WHERE userId = ? ORDER BY updatedAt DESC', [req.params.userId]); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/rest/conversations/:userId/:id', async (req, res) => { try { const [conv] = query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [req.params.id, req.params.userId]); if (!conv[0]) return res.status(404).json({ error: 'Not found' }); const [msgs] = query('SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt', [req.params.id]); res.json({ ...conv[0], messages: msgs }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/rest/conversations/:userId', async (req, res) => { try { const [result] = query('INSERT INTO conversations (userId, title, createdAt, updatedAt) VALUES (?, ?, NOW(), NOW())', [req.params.userId, req.body.title]); res.json({ id: result.insertId, userId: Number(req.params.userId), title: req.body.title, createdAt: new Date(), updatedAt: new Date() }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.delete('/api/rest/conversations/:userId/:id', async (req, res) => { try { query('DELETE FROM messages WHERE conversationId = ?', [req.params.id]); query('DELETE FROM conversations WHERE id = ?', [req.params.id]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/rest/messages/:userId', async (req, res) => { try { const { conversationId, content } = req.body; const [conv] = query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [conversationId, req.params.userId]); if (!conv[0]) return res.status(404).json({ error: 'Not found' }); query('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'user', content]); const [history] = query('SELECT role, content FROM messages WHERE conversationId = ? ORDER BY createdAt', [conversationId]); const aiContent = generateAIResponse(content, history); const [result] = query('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'assistant', aiContent]); query('UPDATE conversations SET updatedAt = NOW() WHERE id = ?', [conversationId]); res.json({ messageId: result.insertId, content: aiContent, conversationId }); } catch (e) { res.status(500).json({ error: e.message }); } });

// For Vercel serverless - export the app
module.exports = app;
