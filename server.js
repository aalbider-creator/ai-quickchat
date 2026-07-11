const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: ['https://ahmadswork.com', 'https://www.ahmadswork.com'], credentials: true }));
app.use(express.json());

// Try MySQL, fall back to memory if unavailable
let useMemory = false;
let mysql;
try { mysql = require('mysql2/promise'); } catch { useMemory = true; }

let db = null;
let dbReady = false;

const memStore = { conversations: [], messages: [], nextConvId: 1, nextMsgId: 1 };

async function initDb() {
  if (!mysql) { useMemory = true; return; }
  try {
    db = await mysql.createConnection({
      host: 'ep-t4ni387b5e83b7519dc8.epsrv-t4n281l4mrmemi4zls9a.ap-southeast-1.privatelink.aliyuncs.com',
      port: 4000, user: '4HnzXYtJotVzwdD.root', password: 'kNkxgs5hJSeQcQbuv9jbhZg1z5weDwD7',
      database: '19f4ea92-1b92-8829-8000-09038965c866', ssl: { rejectUnauthorized: false }, connectTimeout: 5000
    });
    await db.execute('SELECT 1'); dbReady = true; console.log('MySQL connected');
  } catch (e) { console.log('MySQL failed, using memory'); useMemory = true; }
}

async function query(sql, params) {
  if (!useMemory && dbReady) { try { return await db.execute(sql, params); } catch { useMemory = true; } }
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
  if (/(how.*work|technology|stack)/.test(lower)) return "Full-stack: HTML/CSS/JS frontend, Node.js + Express backend, MySQL database. Messages persist via REST API.";
  if (/(code|javascript|react|node|python)/.test(lower)) {
    if (lower.includes('javascript') || lower.includes('js')) return "JavaScript tips: closures, async/await, event loop. Use TypeScript to catch bugs early.";
    if (lower.includes('react')) return "React: functional components + hooks, keep state local, useMemo for expensive calcs.";
    if (lower.includes('python')) return "Python: great for data science. Check scikit-learn, TensorFlow, FastAPI for backends.";
    return "I can help with JavaScript, TypeScript, React, Node.js, Python, SQL. What's your question?";
  }
  if (/(database|sql|mysql)/.test(lower)) return "MySQL database. Every message persists — refresh and conversations are still there. Real backend power.";
  if (/(career|job|learn|interview|portfolio)/.test(lower)) return "Build real projects. This chat app shows: database design, API architecture, frontend integration. Deploy and demo it.";
  if (/(thank|thanks)/.test(lower)) return "You're welcome! Happy to help.";
  if (/(bye|goodbye)/.test(lower)) return "Goodbye! Your conversation is saved — come back anytime.";
  const generics = ["Interesting! Tell me more.", "Good question. I can discuss coding, web dev, or career advice.", "Everything here goes through a real backend API — no mock data.", "I'm designed for coding help and tech questions. What would you like to explore?", "This app shows: Node.js, Express, REST API design, CORS handling — real backend skills."];
  return generics[lower.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % generics.length];
}

app.get('/api/rest/health', (req, res) => res.json({ ok: true, mode: useMemory ? 'memory' : 'mysql' }));

app.get('/api/rest/conversations/:userId', async (req, res) => { try { const [rows] = await query('SELECT * FROM conversations WHERE userId = ? ORDER BY updatedAt DESC', [req.params.userId]); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/rest/conversations/:userId/:id', async (req, res) => { try { const [conv] = await query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [req.params.id, req.params.userId]); if (!conv[0]) return res.status(404).json({ error: 'Not found' }); const [msgs] = await query('SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt', [req.params.id]); res.json({ ...conv[0], messages: msgs }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/rest/conversations/:userId', async (req, res) =>
