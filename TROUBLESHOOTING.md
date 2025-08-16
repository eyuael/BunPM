# Troubleshooting Guide

This guide covers common issues and solutions when using Bun Process Manager.

## Table of Contents

- [Installation Issues](#installation-issues)
- [Daemon Issues](#daemon-issues)
- [Process Management Issues](#process-management-issues)
- [Log Issues](#log-issues)
- [Performance Issues](#performance-issues)
- [Configuration Issues](#configuration-issues)
- [Common Use Cases](#common-use-cases)
- [Debugging Tips](#debugging-tips)

## Installation Issues

### Bun Not Found

**Problem:** `bun: command not found`

**Solution:**
```bash
# Install Bun if not already installed
curl -fsSL https://bun.sh/install | bash

# Reload your shell or run:
source ~/.bashrc  # or ~/.zshrc
```

### Permission Errors

**Problem:** Permission denied when installing globally

**Solution:**
```bash
# Use bun's global install directory
bun install -g bun-process-manager

# Or install locally and use npx-style execution
bun install bun-process-manager
bunx bun-pm start app.js
```

### Build Failures

**Problem:** Build fails with TypeScript errors

**Solution:**
```bash
# Ensure you have the latest Bun version
bun upgrade

# Clean and rebuild
bun run clean
bun install
bun run build
```

## Daemon Issues

### Daemon Won't Start

**Problem:** `Failed to connect to daemon`

**Diagnosis:**
```bash
# Check if daemon is running
ps aux | grep bun-pm

# Check daemon logs
cat ~/.bun-pm/daemon.log
```

**Solutions:**

1. **Port/Socket conflicts:**
```bash
# Remove stale socket file
rm ~/.bun-pm/daemon.sock

# Start daemon manually
bun-pm daemon --start
```

2. **Permission issues:**
```bash
# Check directory permissions
ls -la ~/.bun-pm/
chmod 755 ~/.bun-pm/
```

3. **Resource constraints:**
```bash
# Check available memory
free -h

# Check disk space
df -h ~/.bun-pm/
```

### Daemon Crashes

**Problem:** Daemon stops unexpectedly

**Diagnosis:**
```bash
# Check daemon logs for errors
tail -f ~/.bun-pm/daemon.log

# Check system logs
dmesg | grep -i "killed process"
```

**Solutions:**

1. **Memory issues:**
```bash
# Reduce number of managed processes
bun-pm stop some-process

# Increase system memory or add swap
```

2. **File descriptor limits:**
```bash
# Check current limits
ulimit -n

# Increase limits (add to ~/.bashrc)
ulimit -n 4096
```

### Daemon Performance Issues

**Problem:** Slow daemon response times

**Solutions:**

1. **Too many processes:**
```bash
# Check process count
bun-pm list | wc -l

# Consider splitting across multiple daemon instances
```

2. **Log file size:**
```bash
# Check log file sizes
du -sh ~/.bun-pm/logs/*

# Manually rotate large logs
bun-pm logs --rotate-all
```

## Process Management Issues

### Process Won't Start

**Problem:** Process fails to start with no clear error

**Diagnosis:**
```bash
# Check process logs
bun-pm logs process-name --error

# Try starting manually
cd /path/to/script
bun script.js
```

**Common Solutions:**

1. **Script path issues:**
```bash
# Use absolute paths
bun-pm start /full/path/to/script.js

# Or ensure correct working directory
bun-pm start script.js --cwd /path/to/directory
```

2. **Missing dependencies:**
```bash
# Install dependencies in script directory
cd /path/to/script
bun install
```

3. **Environment variables:**
```bash
# Check required environment variables
bun-pm start script.js --env "NODE_ENV=production,API_KEY=value"
```

### Process Keeps Restarting

**Problem:** Process restarts continuously

**Diagnosis:**
```bash
# Check restart count and exit codes
bun-pm show process-name

# Monitor logs in real-time
bun-pm logs process-name --follow
```

**Solutions:**

1. **Fix application errors:**
```bash
# Check application logs for errors
bun-pm logs process-name --error --lines 100
```

2. **Disable auto-restart temporarily:**
```bash
bun-pm stop process-name
bun-pm start script.js --name process-name --no-autorestart
```

3. **Increase memory limit:**
```bash
bun-pm delete process-name
bun-pm start script.js --name process-name --memory 1G
```

### Memory Limit Issues

**Problem:** Process killed due to memory limits

**Diagnosis:**
```bash
# Check memory usage
bun-pm monit

# Check memory limit settings
bun-pm show process-name
```

**Solutions:**

1. **Increase memory limit:**
```bash
bun-pm stop process-name
bun-pm start script.js --name process-name --memory 2G
```

2. **Optimize application:**
```bash
# Profile memory usage in your application
# Look for memory leaks
# Optimize data structures
```

## Log Issues

### Missing Logs

**Problem:** No logs appear for a process

**Diagnosis:**
```bash
# Check if process is capturing output
ls -la ~/.bun-pm/logs/process-name/

# Check process configuration
bun-pm show process-name
```

**Solutions:**

1. **Application not logging to stdout/stderr:**
```javascript
// Ensure your app logs to console
console.log("This will be captured");
console.error("This will also be captured");
```

2. **Log directory permissions:**
```bash
chmod -R 755 ~/.bun-pm/logs/
```

### Log Files Too Large

**Problem:** Log files consuming too much disk space

**Solutions:**

1. **Manual log rotation:**
```bash
# Rotate logs for specific process
bun-pm logs process-name --rotate

# Rotate all logs
bun-pm logs --rotate-all
```

2. **Reduce log verbosity:**
```bash
# Configure your application to log less
# Use log levels (error, warn, info, debug)
```

### Log Streaming Issues

**Problem:** `bun-pm logs --follow` not working

**Solutions:**

1. **Check process status:**
```bash
bun-pm list
# Ensure process is running
```

2. **Restart log streaming:**
```bash
# Stop and restart the logs command
# Try without --follow first
bun-pm logs process-name --lines 10
```

## Performance Issues

### High CPU Usage

**Problem:** Daemon or processes using too much CPU

**Diagnosis:**
```bash
# Monitor CPU usage
top -p $(pgrep bun-pm)

# Check individual process CPU
bun-pm monit
```

**Solutions:**

1. **Reduce monitoring frequency:**
```bash
# Edit daemon configuration to reduce monitoring interval
# (This would require daemon restart)
```

2. **Optimize managed processes:**
```bash
# Profile your applications
# Look for CPU-intensive operations
# Consider process scaling
```

### High Memory Usage

**Problem:** Daemon consuming too much memory

**Diagnosis:**
```bash
# Check daemon memory usage
ps aux | grep bun-pm-daemon

# Check total managed process memory
bun-pm monit
```

**Solutions:**

1. **Reduce process count:**
```bash
# Stop unnecessary processes
bun-pm stop unused-process
```

2. **Set memory limits:**
```bash
# Add memory limits to all processes
bun-pm start script.js --memory 512M
```

### Slow Command Response

**Problem:** CLI commands take too long to respond

**Solutions:**

1. **Check daemon load:**
```bash
bun-pm monit
# Look for high CPU/memory usage
```

2. **Restart daemon:**
```bash
bun-pm daemon --restart
```

## Configuration Issues

### Invalid Ecosystem File

**Problem:** Ecosystem file won't load

**Diagnosis:**
```bash
# Validate JSON syntax
bun -e "console.log(JSON.parse(require('fs').readFileSync('ecosystem.json', 'utf8')))"
```

**Solutions:**

1. **Fix JSON syntax:**
```bash
# Use a JSON validator or linter
# Check for trailing commas, missing quotes, etc.
```

2. **Validate configuration:**
```bash
# Check required fields are present
# Ensure script paths exist
# Verify memory format (e.g., "512M", "1G")
```

### Environment Variable Issues

**Problem:** Environment variables not being set

**Solutions:**

1. **Check ecosystem configuration:**
```json
{
  "apps": [{
    "name": "app",
    "script": "server.js",
    "env": {
      "NODE_ENV": "production",
      "PORT": "3000"
    }
  }]
}
```

2. **Verify in process:**
```javascript
// In your application
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);
```

## Common Use Cases

### Web Application with Load Balancing

```bash
# Start multiple instances of a web server
bun-pm start server.js --name "web" --instances 4

# Each instance gets a unique PORT:
# Instance 0: PORT=3000
# Instance 1: PORT=3001
# Instance 2: PORT=3002
# Instance 3: PORT=3003

# Use a reverse proxy (nginx, etc.) to distribute load
```

### Background Job Processing

```bash
# Start worker processes for job queues
bun-pm start worker.js --name "worker" --instances 2 --memory 1G

# Monitor worker performance
bun-pm monit

# Scale workers based on queue size
bun-pm scale worker 4
```

### Microservices Architecture

```bash
# Use ecosystem file for multiple services
bun-pm start microservices.json

# Monitor all services
bun-pm list

# Check individual service health
bun-pm show auth-service
bun-pm show user-service
```

### Development Environment

```bash
# Start development servers with auto-restart
bun-pm start dev-server.js --name "frontend" --env "NODE_ENV=development"
bun-pm start api-server.js --name "backend" --env "NODE_ENV=development"

# Watch logs during development
bun-pm logs frontend --follow
```

### Scheduled Tasks

```bash
# Start cron-like scheduled tasks
bun-pm start scheduler.js --name "daily-backup" --memory 256M

# Monitor scheduled task execution
bun-pm logs daily-backup --follow
```

## Debugging Tips

### Enable Debug Logging

```bash
# Set debug environment variable
export DEBUG=bun-pm:*
bun-pm start app.js

# Or for specific modules
export DEBUG=bun-pm:daemon,bun-pm:process-manager
```

### Check System Resources

```bash
# Memory usage
free -h

# Disk space
df -h

# File descriptors
lsof | wc -l
ulimit -n

# Process count
ps aux | wc -l
```

### Network Issues

```bash
# Check if ports are in use
netstat -tulpn | grep :3000

# Test socket connectivity
nc -U ~/.bun-pm/daemon.sock
```

### File System Issues

```bash
# Check permissions
ls -la ~/.bun-pm/

# Check disk space
du -sh ~/.bun-pm/

# Check inode usage
df -i
```

### Process Debugging

```bash
# Attach to running process
strace -p $(pgrep -f "your-script.js")

# Check process file descriptors
ls -la /proc/$(pgrep -f "your-script.js")/fd/

# Monitor system calls
strace -f bun-pm start app.js
```

## Getting Help

If you're still experiencing issues:

1. **Check the logs:**
   ```bash
   bun-pm logs --daemon
   cat ~/.bun-pm/daemon.log
   ```

2. **Gather system information:**
   ```bash
   bun --version
   uname -a
   free -h
   df -h
   ```

3. **Create a minimal reproduction case:**
   - Simple script that demonstrates the issue
   - Exact commands used
   - Error messages and logs

4. **Report the issue:**
   - Include system information
   - Provide reproduction steps
   - Attach relevant logs

## Performance Tuning

### Daemon Optimization

```bash
# Reduce monitoring interval (edit daemon config)
# Increase file descriptor limits
ulimit -n 8192

# Use SSD storage for log files
# Consider log compression for long-term storage
```

### Process Optimization

```bash
# Set appropriate memory limits
bun-pm start app.js --memory 512M

# Use clustering for CPU-intensive apps
bun-pm start app.js --instances $(nproc)

# Monitor and adjust based on metrics
bun-pm monit
```

### System Optimization

```bash
# Increase system limits
echo "fs.file-max = 65536" >> /etc/sysctl.conf
echo "* soft nofile 65536" >> /etc/security/limits.conf
echo "* hard nofile 65536" >> /etc/security/limits.conf

# Optimize for high process count
echo "kernel.pid_max = 32768" >> /etc/sysctl.conf
```