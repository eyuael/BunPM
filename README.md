# Bun Process Manager

A Bun-native process manager inspired by PM2 that leverages Bun's built-in tools and APIs to provide fast, efficient process management for Node.js and Bun applications.

## Features

- 🚀 **Bun-Native**: Built specifically for Bun runtime with optimized performance
- 🔄 **Auto-Restart**: Automatic process restart on crashes with configurable policies
- 📊 **Monitoring**: Real-time CPU and memory monitoring with resource limits
- 📝 **Log Management**: Automatic log capture, rotation, and streaming
- 🔧 **Clustering**: Multi-instance support for load balancing
- ⚙️ **Configuration**: Ecosystem files for complex multi-service setups
- 🛡️ **Error Handling**: Robust error recovery and graceful shutdowns
- 💾 **Persistence**: Process configurations survive daemon restarts

## Installation

### From Source

```bash
git clone <repository-url>
cd bun-process-manager
bun install
bun run build
```

### Global Installation

```bash
# Install globally (when published)
bun install -g bun-process-manager
```

## Quick Start

```bash
# Start your first process
bun-pm start server.js --name "my-app"

# List all processes
bun-pm list

# View real-time logs
bun-pm logs my-app --follow

# Scale to multiple instances
bun-pm scale my-app 4

# Stop the process
bun-pm stop my-app
```

## Usage

### Basic Commands

#### Starting Processes

```bash
# Start a simple process
bun-pm start app.js

# Start with a custom name
bun-pm start app.js --name "web-server"

# Start with environment variables
bun-pm start app.js --name "api" --env NODE_ENV=production

# Start multiple instances (clustering)
bun-pm start app.js --name "cluster-app" --instances 4

# Start without auto-restart
bun-pm start app.js --name "one-shot" --no-autorestart

# Start with memory limit
bun-pm start app.js --name "limited" --memory 512M
```

#### Process Management

```bash
# List all processes
bun-pm list

# Show detailed process information
bun-pm show my-app

# Stop a process
bun-pm stop my-app

# Restart a process
bun-pm restart my-app

# Delete a process configuration
bun-pm delete my-app

# Scale process instances
bun-pm scale my-app 8
```

#### Log Management

```bash
# View last 100 lines of logs
bun-pm logs my-app

# View last 50 lines
bun-pm logs my-app --lines 50

# Follow logs in real-time
bun-pm logs my-app --follow

# View error logs only
bun-pm logs my-app --error
```

#### Monitoring

```bash
# Real-time monitoring dashboard
bun-pm monit

# Show detailed process metrics
bun-pm show my-app
```

#### Configuration Management

```bash
# Save current processes to ecosystem file
bun-pm save ecosystem.json

# Start processes from ecosystem file
bun-pm start ecosystem.json

# Reload processes from ecosystem file
bun-pm reload ecosystem.json
```

### Advanced Usage

#### Clustering with Load Balancing

```bash
# Start a web server with 4 instances
bun-pm start server.js --name "web" --instances 4

# Each instance gets a unique PORT environment variable:
# Instance 0: PORT=3000
# Instance 1: PORT=3001
# Instance 2: PORT=3002
# Instance 3: PORT=3003
```

#### Memory Management

```bash
# Set memory limit (process restarts if exceeded)
bun-pm start memory-intensive.js --memory 1G

# Monitor memory usage
bun-pm monit
```

#### Working Directory and Environment

```bash
# Start process in specific directory
bun-pm start ../other-project/app.js --cwd /path/to/project

# Set multiple environment variables
bun-pm start app.js --env "NODE_ENV=production,API_KEY=secret"
```

## Ecosystem Configuration

Create an `ecosystem.json` file to manage multiple processes:

```json
{
  "apps": [
    {
      "name": "web-server",
      "script": "server.js",
      "instances": 4,
      "autorestart": true,
      "memory": "512M",
      "env": {
        "NODE_ENV": "production",
        "PORT": 3000
      }
    },
    {
      "name": "worker",
      "script": "worker.js",
      "instances": 2,
      "cwd": "./workers",
      "env": {
        "WORKER_TYPE": "background"
      }
    },
    {
      "name": "scheduler",
      "script": "scheduler.js",
      "autorestart": true,
      "memory": "256M",
      "env": {
        "SCHEDULE_INTERVAL": "60000"
      }
    }
  ]
}
```

Start all processes:

```bash
bun-pm start ecosystem.json
```

### Example Configurations

The `examples/` directory contains ready-to-use ecosystem configurations:

- **[ecosystem.json](./examples/ecosystem.json)** - Basic production setup
- **[microservices.json](./examples/microservices.json)** - Microservices architecture
- **[development.json](./examples/development.json)** - Development environment

See the [examples documentation](./examples/README.md) for detailed explanations and best practices.

## Bun-Specific Features

### Performance Optimizations

- **Fast Startup**: Leverages Bun's quick cold start for minimal daemon initialization time
- **Native APIs**: Uses `Bun.spawn()`, `Bun.file()`, and `Bun.serve()` for optimal performance
- **Efficient JSON**: Utilizes Bun's optimized JSON parsing for configuration handling
- **Stream Processing**: Native Bun streams for efficient log processing

### Memory Efficiency

- **Low Overhead**: Daemon typically uses <50MB of memory
- **Efficient Spawning**: Minimal process creation overhead with `Bun.spawn()`
- **Smart Log Streaming**: Prevents memory buildup during log operations

### Integration Benefits

- **Native File Operations**: Fast configuration and log file handling
- **Built-in HTTP**: Health checks and monitoring using Bun's HTTP client
- **TypeScript Support**: Full TypeScript support without additional compilation

## API Reference

### Command Line Interface

| Command | Description | Options |
|---------|-------------|---------|
| `start <script>` | Start a new process | `--name`, `--instances`, `--memory`, `--env`, `--cwd`, `--no-autorestart` |
| `stop <name\|id>` | Stop a process | None |
| `restart <name\|id>` | Restart a process | None |
| `delete <name\|id>` | Delete process configuration | `--force` |
| `list` | List all processes | `--json` |
| `show <name\|id>` | Show detailed process info | `--json` |
| `logs <name\|id>` | View process logs | `--lines`, `--follow`, `--error` |
| `scale <name\|id> <instances>` | Scale process instances | None |
| `monit` | Real-time monitoring | None |
| `save [file]` | Save ecosystem configuration | None |
| `reload <file>` | Reload from ecosystem file | None |

### Process Status Values

- `running`: Process is active and healthy
- `stopped`: Process has been manually stopped
- `errored`: Process failed to start or crashed too many times
- `restarting`: Process is being restarted

## Development

### Setup

```bash
# Clone and install dependencies
git clone <repository-url>
cd bun-process-manager
bun install
```

### Running Tests

```bash
# Run all tests
bun test

# Run specific test suites
bun run test:unit          # Unit tests
bun run test:integration   # Integration tests
bun run test:performance   # Performance tests
bun run test:e2e          # End-to-end tests
bun run test:stress       # Stress tests

# Run comprehensive test suite
bun run test:comprehensive

# Run performance benchmarks
bun run benchmark
```

### Building

```bash
# Build for production
bun run build

# Clean build artifacts
bun run clean
```

### Development Mode

```bash
# Run in development mode
bun run dev start server.js --name test-app
```

## Performance

### Benchmarks

- **Daemon Startup**: <100ms cold start
- **Process Creation**: <50ms per process
- **Command Response**: <10ms average
- **Memory Footprint**: <50MB daemon overhead
- **Concurrent Processes**: Tested with 1000+ processes

### Scalability

The process manager is designed to handle:
- 1000+ concurrent managed processes
- High-frequency log output (>1000 lines/second)
- Rapid process cycling and restarts
- Large ecosystem configurations (100+ apps)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Run the test suite
6. Submit a pull request

## License

MIT License - see LICENSE file for details

## Documentation

- **[Troubleshooting Guide](./TROUBLESHOOTING.md)** - Common issues and solutions
- **[Bun Features](./BUN_FEATURES.md)** - Bun-specific optimizations and features
- **[Configuration Examples](./examples/README.md)** - Ecosystem file examples and best practices

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues and solutions.
