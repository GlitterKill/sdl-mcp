# Adapter Plugin SDK - Security Documentation

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

Security considerations, best practices, and trust boundaries for SDL-MCP adapter plugins.

## Table of Contents

- [Overview](#overview)
- [Security Model](#security-model)
- [Trusted Execution Paths](#trusted-execution-paths)
- [Threat Model](#threat-model)
- [Security Best Practices](#security-best-practices)
- [Plugin Security](#plugin-security)
- [SDL-MCP Security](#sdl-mcp-security)
- [Auditing and Validation](#auditing-and-validation)
- [Incident Response](#incident-response)

## Overview

SDL-MCP's plugin system allows external code to run within the indexer process. This creates potential security risks that must be understood and mitigated.

**Key Security Principles**:

1. **Explicit Trust**: Plugins are trusted code and execute with full process permissions
2. **Validation**: Plugin manifests and adapters are validated before loading
3. **Isolation**: Consider running in isolated environments for untrusted plugins
4. **Verification**: Use signed/verified plugins from trusted sources

## Security Model

### Trust Boundaries

```
┌─────────────────────────────────────────────────────┐
│               User/System                          │
│  (Configures which plugins to load)                │
└────────────────────┬────────────────────────────────┘
                     │ Trusted Path
                     │ (Plugin files)
┌────────────────────▼────────────────────────────────┐
│              SDL-MCP Host                          │
│  - Validates manifests                            │
│  - Checks API versions                            │
│  - Loads plugin modules                           │
└────────────────────┬────────────────────────────────┘
                     │ Plugin Execution
                     │ (Full process access)
┌────────────────────▼────────────────────────────────┐
│              Plugin Code                           │
│  - Runs with host permissions                      │
│  - Can access file system                          │
│  - Can make network requests                       │
│  - Can execute system commands                     │
└─────────────────────────────────────────────────────┘
```

### Execution Permissions

Plugins execute with the same permissions as the SDL-MCP process:

- **File System Access**: Read/write files accessible to the user running SDL-MCP
- **Network Access**: Make HTTP/HTTPS requests
- **Process Access**: Spawn child processes
- **Environment Access**: Read environment variables
- **Module Access**: Import any Node.js module

**Critical**: Plugins are **not sandboxed** by default.

## Trusted Execution Paths

### Recommended Directory Structure

Use a dedicated, protected directory for trusted plugins:

```
/usr/local/lib/sdl-mcp/plugins/          # Linux/macOS
├── my-lang-plugin/
│   └── dist/
│       └── index.js
└── another-plugin/
    └── dist/
        └── index.js

C:\Program Files\sdl-mcp\plugins\        # Windows
├── my-lang-plugin\
│   └── dist\
│       └── index.js
└── another-plugin\
    └── dist\
        └── index.js
```

### Configuration Best Practices

**1. Use Absolute Paths** (recommended):

```json
{
  "plugins": {
    "paths": [
      "/usr/local/lib/sdl-mcp/plugins/my-lang-plugin/dist/index.js",
      "/usr/local/lib/sdl-mcp/plugins/another-plugin/dist/index.js"
    ]
  }
}
```

**2. Restrict Directory Access**:

```bash
# Set ownership
sudo chown -R root:sdl-mcp /usr/local/lib/sdl-mcp/plugins

# Set permissions
sudo chmod 755 /usr/local/lib/sdl-mcp/plugins
sudo chmod 755 /usr/local/lib/sdl-mcp/plugins/*/dist
sudo chmod 644 /usr/local/lib/sdl-mcp/plugins/*/dist/*.js

# Make read-only
sudo chattr +i /usr/local/lib/sdl-mcp/plugins/my-lang-plugin/dist/index.js  # Linux
sudo chflags schg /usr/local/lib/sdl-mcp/plugins/my-lang-plugin/dist/index.js  # macOS
```

**3. Use Dedicated User**:

```bash
# Create dedicated user
sudo useradd -r -s /bin/false sdl-mcp

# Run SDL-MCP as dedicated user
sudo -u sdl-mcp sdl-mcp index
```

### Path Validation

SDL-MCP validates plugin paths before loading:

```typescript
// Validates:
// - Path exists
// - Path is readable
// - File has .js or .mjs extension
// - Path is within allowed directories (if configured)
```

**Do Not Load Plugins From**:

- `/tmp` or temporary directories
- User-writable directories (e.g., `~/Downloads`)
- Network shares without verification
- Untrusted Git repositories

## Threat Model

### Potential Attack Vectors

#### 1. Malicious Code Execution

**Attack**: Plugin contains malicious code

**Impact**:

- Data theft (read sensitive files)
- Data corruption (write/delete files)
- System compromise (execute commands)
- Network attacks (send data to external servers)

**Mitigation**:

- Only install plugins from trusted sources
- Review plugin code before installation
- Use signed/verified plugins
- Run in isolated environment (containers, VMs)

#### 2. Dependency Confusion

**Attack**: Plugin installs malicious dependencies

**Impact**:

- Supply chain attack via npm/yarn
- Code execution during plugin load
- Data exfiltration

**Mitigation**:

- Lock dependency versions (`package-lock.json`)
- Use npm audit (`npm audit`)
- Configure private registry
- Review `package.json` dependencies

#### 3. Version Bypass

**Attack**: Plugin claims compatibility but uses incompatible APIs

**Impact**:

- Crashes or undefined behavior
- Security vulnerabilities

**Mitigation**:

- Enable `strictVersioning` in config
- Verify manifest API version matches host
- Test plugins in development first

#### 4. Resource Exhaustion

**Attack**: Plugin consumes excessive resources

**Impact**:

- Denial of service (DoS)
- System hangs
- Disk space exhaustion

**Mitigation**:

- Set resource limits (ulimit, cgroups)
- Monitor plugin performance
- Implement timeouts in plugin code

#### 5. Path Traversal

**Attack**: Plugin reads/writes files outside intended scope

**Impact**:

- Access to sensitive files
- Unauthorized data modification

**Mitigation**:

- Validate all file paths
- Use path normalization
- Restrict working directory

## Security Best Practices

### For Plugin Authors

#### 1. Input Validation

```typescript
// Bad: Trust user input
extractSymbols(tree, content, filePath) {
  const data = JSON.parse(content);  // May throw or execute malicious code
}

// Good: Validate input
extractSymbols(tree, content, filePath) {
  try {
    const data = JSON.parse(content);

    if (!data || typeof data !== 'object') {
      return [];
    }

    return this.extractFromData(data);
  } catch (error) {
    console.error(`Invalid JSON in ${filePath}:`, error);
    return [];
  }
}
```

#### 2. Path Sanitization

```typescript
// Bad: Direct path usage
import fs from "fs";

function readFile(path: string) {
  return fs.readFileSync(path); // Could read any file
}

// Good: Sanitize path
import path from "path";
import fs from "fs";

function readFile(baseDir: string, userPath: string) {
  const resolved = path.resolve(baseDir, userPath);

  if (!resolved.startsWith(baseDir)) {
    throw new Error("Path traversal attempt detected");
  }

  return fs.readFileSync(resolved);
}
```

#### 3. Safe Deserialization

```typescript
// Bad: Eval or Function constructor
const data = eval(userInput); // Dangerous!

// Better: JSON.parse
const data = JSON.parse(userInput);

// Best: Validate schema
import { z } from "zod";

const schema = z.object({
  name: z.string(),
  value: z.number(),
});

const data = schema.parse(JSON.parse(userInput));
```

#### 4. Avoid Arbitrary Code Execution

```typescript
// Bad: Dynamic imports from user input
const module = await import(userModule); // Dangerous!

// Bad: Function constructor
const func = new Function(userInput); // Dangerous!

// Bad: child_process.exec with user input
import { exec } from "child_process";
exec(`ls ${userPath}`); // Command injection!

// Good: Use safe alternatives
import { execFile } from "child_process";
execFile("ls", [userPath]); // Safe
```

#### 5. Limit Resource Usage

```typescript
// Good: Add timeouts
async extractSymbols(tree, content, filePath) {
  const timeout = setTimeout(() => {
    throw new Error('Extraction timeout');
  }, 5000); // 5 second timeout

  try {
    const symbols = await this.doExtract(tree, content, filePath);
    clearTimeout(timeout);
    return symbols;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}
```

### For SDL-MCP Administrators

#### 1. Use Dedicated User

```bash
# Create limited user
sudo useradd -r -s /bin/false -d /var/lib/sdl-mcp sdl-mcp

# Set ownership
sudo chown -R sdl-mcp:sdl-mcp /var/lib/sdl-mcp

# Run as limited user
sudo -u sdl-mcp sdl-mcp index
```

#### 2. Set Resource Limits

```bash
# Using ulimit (temporary)
ulimit -n 1024      # Limit file descriptors
ulimit -u 512       # Limit user processes
ulimit -v 4194304   # Limit virtual memory (4GB)

# Using cgroups (permanent)
sudo cgcreate -g memory,cpu:sdl-mcp
sudo cgset -r memory.limit_in_bytes=4G sdl-mcp
sudo cgexec -g memory,cpu:sdl-mcp sdl-mcp index
```

#### 3. File System Permissions

```bash
# Create secure plugin directory
sudo mkdir -p /opt/sdl-mcp/plugins

# Set restrictive permissions
sudo chown root:sdl-mcp /opt/sdl-mcp/plugins
sudo chmod 755 /opt/sdl-mcp/plugins

# Make plugin files read-only
sudo chmod 644 /opt/sdl-mcp/plugins/*/dist/*.js

# Prevent modification
sudo chattr +i /opt/sdl-mcp/plugins/*/dist/*.js  # Linux
```

#### 4. Network Restrictions

```bash
# Using firewall
sudo ufw deny out from any to any port 80,443  # Block HTTP/HTTPS
sudo ufw allow out from any to any port 80,443 proto tcp owner sdl-mcp  # Allow only for sdl-mcp user

# Or run without network access
sudo -u sdl-mcp unshare -n sdl-mcp index
```

#### 5. Audit Plugin Changes

```bash
# Monitor plugin directory
sudo auditctl -w /opt/sdl-mcp/plugins -p wa -k sdl-mcp-plugins

# Log plugin loading
tail -f /var/log/sdl-mcp.log | grep "Plugin loaded"
```

#### 6. Use Containerization

```dockerfile
# Dockerfile for isolated execution
FROM node:20-slim

# Create non-root user
RUN useradd -r -s /bin/false sdl-mcp

# Install SDL-MCP
COPY package*.json ./
RUN npm ci --production

# Copy plugins (verified only)
COPY plugins/ /opt/sdl-mcp/plugins/

# Set permissions
RUN chown -R sdl-mcp:sdl-mcp /opt/sdl-mcp

USER sdl-mcp
WORKDIR /opt/sdl-mcp

# Run without network (optional)
# --network=none
```

```bash
# Run with limited capabilities
docker run --rm \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  -v /path/to/repos:/repos:ro \
  sdl-mcp:latest index
```

## Plugin Security

### Dependency Management

**1. Use `package-lock.json`**:

```bash
# Generate lockfile
npm install

# Commit lockfile
git add package-lock.json
git commit -m "Add dependency lockfile"
```

**2. Audit dependencies**:

```bash
# Check for vulnerabilities
npm audit

# Fix automatically
npm audit fix

# Review dependencies
npm list --depth=0
```

**3. Use private registry**:

```bash
# Configure npm
npm config set registry https://npm.yourcompany.com

# Or per project
npm config set @yourcompany:registry https://npm.yourcompany.com
```

### Code Signing (Optional)

**1. Sign plugin**:

```bash
# Generate key pair
openssl genrsa -out plugin-private.key 2048
openssl rsa -in plugin-private.key -pubout -out plugin-public.key

# Sign plugin
openssl dgst -sha256 -sign plugin-private.key -out dist/index.js.sig dist/index.js

# Verify signature
openssl dgst -sha256 -verify plugin-public.key -signature dist/index.js.sig dist/index.js
```

**2. Include in manifest**:

```typescript
export const manifest = {
  name: "my-plugin",
  version: "1.0.0",
  signature: "base64-encoded-signature",
  publicKey: "base64-encoded-public-key",
};
```

### Sandboxing (Advanced)

**Use Worker Threads**:

```typescript
import { Worker } from "worker_threads";

function runInIsolation(pluginPath: string, filePath: string) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(pluginPath, {
      workerData: { filePath },
      resourceLimits: {
        maxOldGenerationSizeMb: 512, // Limit memory
      },
    });

    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0)
        reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
}
```

**Use VM Isolation** (for maximum security):

```bash
# Create VM
virt-install --name sdl-mcp-worker \
  --ram 1024 \
  --vcpus 2 \
  --disk path=/var/lib/libvirt/images/sdl-mcp-worker.qcow2,size=10 \
  --network none

# Copy and run
scp my-plugin.qcow2 root@vm:/opt/sdl-mcp/plugins/
ssh root@vm "sdl-mcp index"
```

## SDL-MCP Security

### Validation

**1. Manifest Validation**:

```typescript
// Validates:
// - Required fields present
// - Field types correct
// - API version compatible
// - Adapter extensions unique
```

**2. Adapter Validation**:

```typescript
// Validates:
// - createAdapters() returns array
// - Each adapter has extension, languageId, factory
// - factory function is callable
// - Adapter implements LanguageAdapter interface
```

**3. Runtime Checks**:

```typescript
// Runtime validation:
// - Symbol IDs unique
// - File paths normalized
// - Ranges valid
// - No null/undefined in extracted data
```

### Logging

SDL-MCP logs security-relevant events:

```
[INFO] Plugin loaded: my-plugin@1.0.0 from /path/to/plugin.js
[WARN] Plugin my-plugin overrides built-in adapter for .ts
[ERROR] Failed to load plugin: Invalid manifest
[ERROR] Plugin security violation: Attempted to read /etc/passwd
```

**Monitor logs**:

```bash
# Watch for security events
tail -f /var/log/sdl-mcp.log | grep -i "security\|error\|failed"

# Alert on suspicious activity
tail -f /var/log/sdl-mcp.log | grep "security violation" | mail -s "SDL-MCP Security Alert" admin@example.com
```

## Auditing and Validation

### Pre-Installation Checklist

Before installing a plugin, verify:

- [ ] Source is trusted (official repo, verified author)
- [ ] Code has been reviewed
- [ ] No suspicious dependencies
- [ ] Manifest is valid
- [ ] API version matches host
- [ ] Plugin has tests
- [ ] Plugin has documentation
- [ ] License is compatible

### Code Review Checklist

When reviewing plugin code:

- [ ] No `eval()` or `Function()`
- [ ] No `child_process.exec()` with user input
- [ ] All file paths validated
- [ ] All inputs validated
- [ ] Error handling present
- [ ] No hard-coded secrets
- [ ] No excessive resource usage
- [ ] No network requests to untrusted hosts

### Runtime Monitoring

Monitor for suspicious activity:

```bash
# Monitor file access
strace -f -e trace=open,openat,read,write sdl-mcp index 2>&1 | grep -v "ENOENT"

# Monitor network activity
strace -f -e trace=socket,connect,sendto,recvfrom sdl-mcp index 2>&1

# Monitor process spawning
strace -f -e trace=clone,fork,vfork,execve sdl-mcp index 2>&1
```

## Incident Response

### If Malicious Activity Detected

1. **Immediately Stop SDL-MCP**:

   ```bash
   sudo pkill -9 sdl-mcp
   ```

2. **Preserve Evidence**:

   ```bash
   # Copy logs
   cp /var/log/sdl-mcp.log /tmp/sdl-mcp.log.backup

   # Copy plugin
   cp -r /opt/sdl-mcp/plugins/suspicious-plugin /tmp/evidence/

   # Save process state
   gcore $(pgrep sdl-mcp)
   ```

3. **Remove Plugin**:

   ```bash
   sudo rm -rf /opt/sdl-mcp/plugins/suspicious-plugin
   ```

4. **Audit Impact**:

   ```bash
   # Check for modified files
   find /path/to/repos -mtime -1 -ls

   # Check network connections
   sudo netstat -tunp | grep $(pgrep sdl-mcp)

   # Check for new files
   find /path/to/repos -newer /tmp/before-incident
   ```

5. **Report Incident**:
   - Document what happened
   - Preserve evidence
   - Report to security team
   - Notify affected users

### Recovery Steps

1. **Verify Clean State**:

   ```bash
   # Remove all plugins
   sudo rm -rf /opt/sdl-mcp/plugins/*

   # Verify no suspicious processes
   ps aux | grep suspicious-name
   ```

2. **Reinstall Trusted Plugins**:

   ```bash
   # Reinstall from trusted source
   cp -r /backup/safe-plugins/* /opt/sdl-mcp/plugins/
   ```

3. **Verify Integrity**:

   ```bash
   # Check file hashes
   sha256sum /opt/sdl-mcp/plugins/*/dist/*.js

   # Compare with known good values
   sha256sum -c checksums.txt
   ```

4. **Resume Operations**:

   ```bash
   # Start SDL-MCP
   sudo -u sdl-mcp sdl-mcp index

   # Monitor logs
   tail -f /var/log/sdl-mcp.log
   ```

## Summary

**Critical Security Points**:

1. Plugins execute with full process permissions
2. Only load plugins from trusted sources
3. Validate all inputs and paths
4. Monitor for suspicious activity
5. Have incident response plan ready
6. Consider containerization for production

**Security is a shared responsibility**:

- Plugin authors must write secure code
- Administrators must configure secure environments
- Users must only use trusted plugins

**When in doubt, sandbox**:

- Use containers for production
- Use isolated user accounts
- Use resource limits
- Monitor all activity

---

## Additional Resources

- [SDL-MCP README](../README.md)
- [Plugin Author Guide](PLUGIN_SDK_AUTHOR_GUIDE.md)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CIS Benchmarks](https://www.cisecurity.org/cis-benchmarks)
