# Multi-Agent Orchestrator 部署指南

**版本**: 0.2.0
**最后更新**: 2026-01-30

---

## 📋 部署前准备

### 系统要求

- **操作系统**: Linux (Ubuntu 20.04+) / WSL2 / macOS
- **Node.js**: v20.0.0 或更高版本
- **内存**: 至少 2GB RAM
- **磁盘**: 至少 1GB 可用空间
- **网络**: 稳定的互联网连接（用于 Claude API）

### 必需的服务

1. **Claude API**
   - Anthropic API Key
   - 足够的 API 配额

2. **Telegram Bot**（可选）
   - Telegram Bot Token
   - Telegram 群聊 ID

3. **数据库**
   - SQLite（已内置，无需额外安装）

---

## 🚀 部署到 WSL2

### 1. 安装 WSL2

```bash
# 在 Windows PowerShell（管理员）中运行
wsl --install -d Ubuntu-22.04

# 重启计算机后，设置 Ubuntu 用户名和密码
```

### 2. 安装 Node.js

```bash
# 更新包管理器
sudo apt update && sudo apt upgrade -y

# 安装 Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证安装
node --version  # 应该显示 v20.x.x
npm --version
```

### 3. 克隆项目

```bash
# 克隆项目到 WSL2
cd ~
git clone <your-repo-url> multi-agent-orchestrator
cd multi-agent-orchestrator

# 或者从 Windows 复制项目
cp -r /mnt/f/Multi-Agent-Orchestrator ~/multi-agent-orchestrator
cd ~/multi-agent-orchestrator
```

### 4. 安装依赖

```bash
npm install
```

### 5. 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑环境变量
nano .env
```

在 `.env` 文件中配置：

```env
# Claude API 配置
ANTHROPIC_API_KEY=sk-ant-xxxxx

# 数据库配置
DB_PATH=./data/orchestrator.db

# 配置根目录
CONFIG_ROOT=/home/your-username/.claude

# Telegram Bot 配置（可选）
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id

# 日志级别
LOG_LEVEL=info

# Worker 数量
WORKER_COUNT=9
```

### 6. 编译项目

```bash
npm run build
```

### 7. 运行测试

```bash
npm test
```

### 8. 启动服务

```bash
# 运行基础示例
npm run example:basic

# 或运行 Telegram Bot
npm run example:telegram
```

---

## 🐳 使用 Docker 部署

### 1. 创建 Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制源代码
COPY . .

# 编译 TypeScript
RUN npm run build

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口（如果需要）
# EXPOSE 3000

# 启动命令
CMD ["node", "dist/index.js"]
```

### 2. 创建 docker-compose.yml

```yaml
version: '3.8'

services:
  orchestrator:
    build: .
    container_name: multi-agent-orchestrator
    restart: unless-stopped
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - DB_PATH=/app/data/orchestrator.db
      - CONFIG_ROOT=/app/config
    volumes:
      - ./data:/app/data
      - ./config:/app/config
    networks:
      - orchestrator-network

networks:
  orchestrator-network:
    driver: bridge
```

### 3. 构建和运行

```bash
# 构建镜像
docker-compose build

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

---

## 🔧 使用 systemd 管理服务

### 1. 创建 systemd 服务文件

```bash
sudo nano /etc/systemd/system/multi-agent-orchestrator.service
```

内容：

```ini
[Unit]
Description=Multi-Agent Orchestrator
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/home/your-username/multi-agent-orchestrator
Environment="NODE_ENV=production"
EnvironmentFile=/home/your-username/multi-agent-orchestrator/.env
ExecStart=/usr/bin/node /home/your-username/multi-agent-orchestrator/dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=multi-agent-orchestrator

[Install]
WantedBy=multi-user.target
```

### 2. 启用和启动服务

```bash
# 重新加载 systemd
sudo systemctl daemon-reload

# 启用服务（开机自启）
sudo systemctl enable multi-agent-orchestrator

# 启动服务
sudo systemctl start multi-agent-orchestrator

# 查看状态
sudo systemctl status multi-agent-orchestrator

# 查看日志
sudo journalctl -u multi-agent-orchestrator -f
```

### 3. 管理服务

```bash
# 停止服务
sudo systemctl stop multi-agent-orchestrator

# 重启服务
sudo systemctl restart multi-agent-orchestrator

# 禁用服务
sudo systemctl disable multi-agent-orchestrator
```

---

## 📊 监控和日志

### 1. 日志管理

```bash
# 查看实时日志
sudo journalctl -u multi-agent-orchestrator -f

# 查看最近 100 行日志
sudo journalctl -u multi-agent-orchestrator -n 100

# 查看今天的日志
sudo journalctl -u multi-agent-orchestrator --since today

# 导出日志
sudo journalctl -u multi-agent-orchestrator > orchestrator.log
```

### 2. 性能监控

```bash
# 安装 PM2（进程管理器）
npm install -g pm2

# 使用 PM2 启动
pm2 start dist/index.js --name multi-agent-orchestrator

# 查看状态
pm2 status

# 查看日志
pm2 logs multi-agent-orchestrator

# 查看监控
pm2 monit

# 重启
pm2 restart multi-agent-orchestrator

# 停止
pm2 stop multi-agent-orchestrator
```

---

## 🔒 安全配置

### 1. 环境变量安全

```bash
# 设置 .env 文件权限
chmod 600 .env

# 确保 .env 不被提交到 Git
echo ".env" >> .gitignore
```

### 2. 数据库安全

```bash
# 设置数据库目录权限
chmod 700 data/
chmod 600 data/*.db
```

### 3. 防火墙配置

```bash
# 如果需要开放端口（例如 API 服务）
sudo ufw allow 3000/tcp
sudo ufw enable
```

---

## 🔄 更新和维护

### 1. 更新代码

```bash
# 拉取最新代码
git pull origin main

# 安装新依赖
npm install

# 重新编译
npm run build

# 重启服务
sudo systemctl restart multi-agent-orchestrator
# 或
pm2 restart multi-agent-orchestrator
```

### 2. 数据库备份

```bash
# 创建备份脚本
cat > backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="./backups"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR
cp data/*.db $BACKUP_DIR/backup_$DATE.db

# 保留最近 7 天的备份
find $BACKUP_DIR -name "backup_*.db" -mtime +7 -delete
EOF

chmod +x backup.sh

# 添加到 crontab（每天凌晨 2 点备份）
crontab -e
# 添加：0 2 * * * /path/to/backup.sh
```

### 3. 日志轮转

```bash
# 创建 logrotate 配置
sudo nano /etc/logrotate.d/multi-agent-orchestrator
```

内容：

```
/var/log/multi-agent-orchestrator/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 your-username your-username
}
```

---

## 🐛 故障排查

### 常见问题

#### 1. 服务无法启动

```bash
# 检查日志
sudo journalctl -u multi-agent-orchestrator -n 50

# 检查环境变量
cat .env

# 检查文件权限
ls -la data/
```

#### 2. API 调用失败

```bash
# 测试 API Key
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-5","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

#### 3. 数据库锁定

```bash
# 检查数据库文件
sqlite3 data/orchestrator.db "PRAGMA integrity_check;"

# 如果损坏，从备份恢复
cp backups/backup_latest.db data/orchestrator.db
```

#### 4. 内存不足

```bash
# 检查内存使用
free -h

# 增加 Node.js 内存限制
export NODE_OPTIONS="--max-old-space-size=4096"
```

---

## 📞 支持

如果遇到问题，请：

1. 查看日志文件
2. 检查环境变量配置
3. 查看 GitHub Issues
4. 提交新的 Issue

---

**文档版本**: 1.0
**最后更新**: 2026-01-30
