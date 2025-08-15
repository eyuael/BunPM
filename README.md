# Bun Process Manager

A Bun-native process manager inspired by PM2 that leverages Bun's built-in tools and APIs to provide fast, efficient process management for Node.js and Bun applications.

## Installation

```bash
bun install
bun run build
```

## Usage

```bash
# Start a process
bun-pm start app.js

# List processes
bun-pm list

# Stop a process
bun-pm stop <name|id>

# View logs
bun-pm logs <name|id>
```

## Development

```bash
# Run in development mode
bun run dev

# Run tests
bun test

# Build for production
bun run build
```