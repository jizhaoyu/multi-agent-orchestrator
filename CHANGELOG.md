# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Clawdbot Gateway integration
- Performance monitoring dashboard
- Advanced task scheduling
- Multi-language support

## [0.2.0] - 2026-01-30

### Added
- Telegram Bot integration framework
- Basic usage example (`examples/basic-usage.ts`)
- Telegram Bot usage example (`examples/telegram-bot.ts`)
- Deployment guide (`docs/deployment.md`)
- Publish guide (`docs/publish-guide.md`)
- Performance optimization guide (`docs/performance.md`)
- Structured message formatting for Telegram
- Real-time progress updates with progress bars
- @mention parsing for agent communication

### Changed
- Updated README with Telegram integration information
- Updated package.json to v0.2.0
- Added example run scripts to package.json

### Dependencies
- Added `node-telegram-bot-api` for Telegram integration
- Added `@types/node-telegram-bot-api` for TypeScript support
- Added `dotenv` for environment variable management

## [0.1.0] - 2026-01-29

### Added
- Initial release of Multi-Agent Orchestrator
- Core Orchestrator implementation
  - Task decomposition algorithm
  - Task assignment strategy
  - Progress monitoring
  - Quality control
  - Error recovery mechanism
- Worker implementation
  - Task execution
  - Heartbeat mechanism
  - Progress reporting
  - Subtask delegation
- Task Manager
  - Priority queue
  - Task tree structure
  - Dependency management (DAG)
  - Circular dependency detection
- State Manager
  - Agent state tracking
  - Heartbeat detection
  - SQLite persistence
- Memory Service
  - Central memory management
  - LRU cache
  - Publish-subscribe pattern
  - File watching
- Claude API integration
  - API client wrapper
  - Context builder
  - Streaming response support
  - Retry strategy with exponential backoff
- Complete TypeScript type definitions
- Comprehensive test suite
  - 6 unit test files
  - 1 integration test file
  - Full coverage of core functionality
- Documentation
  - Architecture documentation
  - README with quick start guide
  - Example configuration file
- Project infrastructure
  - TypeScript configuration
  - ESLint and Prettier setup
  - Git repository initialization
  - npm package configuration

### Technical Details
- Node.js 20+ required
- TypeScript 5+ for type safety
- SQLite for data persistence
- better-sqlite3 for database operations
- async-lock for concurrency control
- lru-cache for memory caching
- Vitest for testing

---

## Version History Summary

- **v0.2.0** (2026-01-30): Telegram integration + Documentation
- **v0.1.0** (2026-01-29): Initial release with core functionality

---

**Maintained by**: Claude Code
**License**: MIT
