const express = require('express');
const PORT = process.env.PORT || 3000;

console.log('Starting test server...');
console.log('PORT from env:', process.env.PORT);
console.log('PORT to use:', PORT);

const app = express();

app.get('/', (req, res) => {
  res.send('✓ Test server works!');
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

console.log('Calling app.listen...');

const server = app.listen(PORT, '0.0.0.0');

server.on('listening', () => {
  const addr = server.address();
  console.log('✓✓✓ Server is LISTENING on:', addr);
  console.log('✓✓✓ Port:', addr.port);
  console.log('✓✓✓ Address:', addr.address);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  console.error('Error code:', err.code);
  console.error('Error message:', err.message);
  process.exit(1);
});

console.log('Test server script finished - waiting for events...');
