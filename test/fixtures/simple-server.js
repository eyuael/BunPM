#!/usr/bin/env bun

// Simple test server that logs its PORT and exits after a short time
const port = process.env.PORT || '3000';
const instance = process.env.NODE_APP_INSTANCE || '0';

console.log(`Server starting on port ${port}, instance ${instance}`);

// Exit after a short time for testing
setTimeout(() => {
  console.log(`Server on port ${port} shutting down`);
  process.exit(0);
}, 100);