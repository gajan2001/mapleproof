const express = require('express');
const PORT = process.env.PORT || 3000;

const app = express();

app.get('/', (req, res) => {
  res.send('Test server works!');
});

const server = app.listen(PORT, '0.0.0.0');

server.on('listening', () => {
  console.log(`✓ Server listening on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

console.log('Test server starting...');