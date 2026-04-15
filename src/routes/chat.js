const express = require('express')
const requireAuth = require('../middleware/requireAuth')
const { streamToResponse, summarize } = require('../anthropic')

const router = express.Router()
router.use(requireAuth)

router.post('/stream', async (req, res) => {
  const { systemPrompt, messages, tools } = req.body
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' })
  }
  await streamToResponse(res, { systemPrompt, messages, tools })
})

router.post('/summarize', async (req, res) => {
  const { messages } = req.body
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' })
  }
  try {
    const summary = await summarize(messages)
    res.json({ summary })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
