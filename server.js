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

// Real AI via Groq API (Llama 3)
async function generateAIResponse(userMsg, history) {
  // Content filter
  const lower = userMsg.toLowerCase();
  if (/(penis|sex|porn|nude|kill|murder|terrorist|bomb)/.test(lower)) {
    return "Let's keep it professional! Ask me about coding, tech, or career advice.";
  }

  if (!process.env.GROQ_API_KEY) {
    return "Add GROQ_API_KEY to Vercel environment variables. Get a free key at console.groq.com";
  }

  try {
    const messages = [
      { role: 'system', content: 'You are a helpful AI coding assistant. Help with JavaScript, React, Node.js, Python, SQL, web development, and tech careers. Be concise but thorough. Use code examples when helpful.' },
      ...history.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
      { role: 'user', content: userMsg }
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: messages,
        temperature: 0.7,
        max_tokens: 800
      })
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    return data.choices[0].message.content;
  } catch (e) {
    console.log('Groq error:', e.message);
    return "AI service temporarily unavailable. Try again in a moment!";
  }
}

app.get('/api/rest/health', (req, res) => res.json({ ok: true, ai: !!process.env.GROQ_API_KEY }));

app.get('/api/rest/conversations/:userId', async (req, res) => { try { const [rows] = query('SELECT * FROM conversations WHERE userId = ? ORDER BY updatedAt DESC', [req.params.userId]); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/rest/conversations/:userId/:id', async (req, res) => { try { const [conv] = query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [req.params.id, req.params.userId]); if (!conv[0]) return res.status(404).json({ error: 'Not found' }); const [msgs] = query('SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt', [req.params.id]); res.json({ ...conv[0], messages: msgs }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/rest/conversations/:userId', async (req, res) => { try { const [result] = query('INSERT INTO conversations (userId, title, createdAt, updatedAt) VALUES (?, ?, NOW(), NOW())', [req.params.userId, req.body.title]); res.json({ id: result.insertId, userId: Number(req.params.userId), title: req.body.title, createdAt: new Date(), updatedAt: new Date() }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.delete('/api/rest/conversations/:userId/:id', async (req, res) => { try { query('DELETE FROM messages WHERE conversationId = ?', [req.params.id]); query('DELETE FROM conversations WHERE id = ?', [req.params.id]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/rest/messages/:userId', async (req, res) => { try { const { conversationId, content } = req.body; const [conv] = query('SELECT * FROM conversations WHERE id = ? AND userId = ?', [conversationId, req.params.userId]); if (!conv[0]) return res.status(404).json({ error: 'Not found' }); query('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'user', content]); const [history] = query('SELECT role, content FROM messages WHERE conversationId = ? ORDER BY createdAt', [conversationId]); const aiContent = await generateAIResponse(content, history); const [result] = query('INSERT INTO messages (conversationId, role, content, createdAt) VALUES (?, ?, ?, NOW())', [conversationId, 'assistant', aiContent]); query('UPDATE conversations SET updatedAt = NOW() WHERE id = ?', [conversationId]); res.json({ messageId: result.insertId, content: aiContent, conversationId }); } catch (e) { res.status(500).json({ error: e.message }); } });

module.exports = app;
