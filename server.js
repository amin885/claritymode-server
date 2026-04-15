require('dotenv').config()
const express = require('express')
const authRoutes = require('./src/routes/auth')
const chatRoutes = require('./src/routes/chat')

const app = express()
app.use(express.json())
app.use('/auth', authRoutes)
app.use('/chat', chatRoutes)

if (require.main === module) {
  const PORT = process.env.PORT || 3000
  app.listen(PORT, () => console.log(`ClarityMode server running on ${PORT}`))
}

module.exports = app
