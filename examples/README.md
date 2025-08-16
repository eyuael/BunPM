# Ecosystem Configuration Examples

This directory contains example ecosystem configuration files for different use cases.

## Files

### `ecosystem.json`
Basic production setup with web server, API gateway, background worker, and scheduler.

**Usage:**
```bash
bun-pm start ecosystem.json
```

**Features:**
- Multi-instance web server with load balancing
- API gateway with upstream timeout configuration
- Background worker with Redis queue integration
- Scheduled tasks with configurable intervals

### `microservices.json`
Complete microservices architecture with multiple services.

**Usage:**
```bash
bun-pm start microservices.json
```

**Features:**
- Authentication service with JWT
- User management service
- Notification service with SMTP
- API gateway routing
- Metrics collection

### `development.json`
Development environment setup with hot reload and testing.

**Usage:**
```bash
bun-pm start development.json
```

**Features:**
- Frontend development server with hot reload
- Backend API server with debug logging
- Automated test runner in watch mode
- SQLite database for local development

## Configuration Options

### Required Fields
- `name`: Unique identifier for the process
- `script`: Path to the JavaScript/TypeScript file to execute

### Optional Fields
- `instances`: Number of instances to run (default: 1)
- `autorestart`: Enable automatic restart on crash (default: true)
- `memory`: Memory limit (e.g., "512M", "1G")
- `cwd`: Working directory for the process
- `env`: Environment variables object

### Environment Variables

Environment variables can be set in the `env` object:

```json
{
  "env": {
    "NODE_ENV": "production",
    "PORT": 3000,
    "API_KEY": "your-api-key"
  }
}
```

### Memory Limits

Memory limits can be specified using standard units:
- `"128M"` - 128 megabytes
- `"1G"` - 1 gigabyte
- `"2048M"` - 2048 megabytes (2GB)

When a process exceeds its memory limit, it will be automatically restarted.

### Clustering

For web applications, you can run multiple instances:

```json
{
  "name": "web-app",
  "script": "server.js",
  "instances": 4
}
```

Each instance will receive a unique `PORT` environment variable:
- Instance 0: `PORT=3000`
- Instance 1: `PORT=3001`
- Instance 2: `PORT=3002`
- Instance 3: `PORT=3003`

### Working Directory

Specify a different working directory for the process:

```json
{
  "name": "service",
  "script": "server.js",
  "cwd": "./services/api"
}
```

This is useful for monorepo setups or when your script files are in subdirectories.

## Best Practices

### Production Setup
1. Always set `NODE_ENV=production`
2. Configure appropriate memory limits
3. Use multiple instances for web services
4. Set up proper logging levels
5. Configure health check endpoints

### Development Setup
1. Use single instances for easier debugging
2. Enable debug logging
3. Set up file watchers for auto-restart
4. Use local databases (SQLite, etc.)
5. Configure hot reload for frontend services

### Security
1. Never commit sensitive data (API keys, passwords) to ecosystem files
2. Use environment variable substitution for secrets
3. Set appropriate memory limits to prevent resource exhaustion
4. Configure proper CORS and security headers

## Validation

The ecosystem configuration is validated when loaded. Common validation errors:

- **Duplicate names**: Each app must have a unique name
- **Invalid memory format**: Use formats like "512M" or "1G"
- **Missing script**: The script file must exist and be executable
- **Invalid instances**: Must be a positive integer

## Environment Variable Substitution

You can use environment variable substitution in ecosystem files:

```json
{
  "env": {
    "DATABASE_URL": "${DATABASE_URL}",
    "API_KEY": "${API_KEY:-default-key}"
  }
}
```

This allows you to keep sensitive data out of configuration files while still using ecosystem configurations.