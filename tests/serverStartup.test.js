const fs = require('fs')
const path = require('path')

describe('production server startup', () => {
  test('starts the generic Skill assignment engine', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')

    expect(source).toContain("require('./src/skillAssignmentEngine')")
    expect(source).not.toContain("require('./src/skillAssignments')")
  })
})
