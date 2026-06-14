const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const axios = require('axios');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// ── CONFIG ──
const CONFIG = {
  N8N_WEBHOOK_URL: 'https://perfoliate-callan-labelloid.ngrok-free.dev/webhook/teacher-workflow',
  DEEPSEEK_API_KEY: 'sk-84d98546d3664ce8ab501ebe2c2431a9',
  DEEPSEEK_API_URL: 'https://api.deepseek.com/v1/chat/completions',
  PORT: 3000
};

// ── IN-MEMORY JOB STORE ──
// Stores job status and results temporarily
const jobs = {};

// Clean up jobs older than 10 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(jobs).forEach(jobId => {
    if (now - jobs[jobId].createdAt > 10 * 60 * 1000) {
      delete jobs[jobId];
    }
  });
}, 5 * 60 * 1000);

// ── EXTRACT LP ──
app.post('/api/extract-lp', upload.single('lpFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const result = await mammoth.extractRawText({ path: req.file.path });
    const docText = result.value;
    fs.unlinkSync(req.file.path);

    const prompt = `Extract all session data from this Learning Plan. Return ONLY valid JSON array, no explanation, no markdown.

Each item must have exactly:
{
  "unit_code": "",
  "unit_title": "",
  "week": "",
  "session_no": "",
  "session_title": "",
  "outcomes": "",
  "key_points": "",
  "activities": "",
  "resources": "",
  "assessment": ""
}

Document:
${docText.substring(0, 8000)}`;

    const response = await axios.post(CONFIG.DEEPSEEK_API_URL, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    let rawText = response.data.choices[0].message.content;
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const extracted = JSON.parse(rawText);

    res.json({ success: true, data: extracted });

  } catch (error) {
    console.error('Extract error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── SUBMIT TO N8N ──
app.post('/api/submit', async (req, res) => {
  try {
    const { jobId, ...formData } = req.body;

    // Create job entry
    jobs[jobId] = {
      status: 'processing',
      createdAt: Date.now(),
      documents: []
    };

    // Send to n8n with jobId and callback URL
    await axios.post(CONFIG.N8N_WEBHOOK_URL, {
      ...formData,
      _jobId: jobId,
      _callbackUrl: `http://host.docker.internal:${CONFIG.PORT}/api/callback`
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    res.json({ success: true, jobId });

  } catch (error) {
    console.error('Submit error:', error.message);
    if (req.body.jobId) {
      jobs[req.body.jobId] = { status: 'error', error: error.message, createdAt: Date.now() };
    }
    res.status(500).json({ error: error.message });
  }
});

// ── POLL STATUS ──
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.json({ status: 'not_found' });
  }
  res.json(job);
});

// ── N8N CALLBACK ──
// n8n calls this when documents are ready
app.post('/api/callback', (req, res) => {
  const { jobId, documents } = req.body;

  console.log('Callback received for job:', jobId, documents);

  if (!jobId) {
    return res.status(400).json({ error: 'jobId required' });
  }

  jobs[jobId] = {
    ...jobs[jobId],
    status: 'done',
    documents: documents || [],
    completedAt: Date.now()
  };

  res.json({ success: true });
});

app.listen(CONFIG.PORT, () => {
  console.log(`TeacherFlow running at http://localhost:${CONFIG.PORT}`);
});
