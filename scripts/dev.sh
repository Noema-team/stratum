#!/usr/bin/env bash

# Stratum Sustained Learning Engine Developer Tool
# Provides unified commands to run, test, build, and clean the stratum environment.

set -euo pipefail

# ANSI color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Print header
show_header() {
  echo -e "${CYAN}"
  echo "  ============================================"
  echo "     STRATUM Sustained Learning Engine (v2)   "
  echo "              Developer CLI Tool              "
  echo "  ============================================"
  echo -e "${NC}"
}

show_help() {
  show_header
  echo "Usage: $0 [command]"
  echo ""
  echo "Commands:"
  echo "  start      Start the Stratum daemon server in foreground mode (Port 7700)"
  echo "  test       Run the universal integration and unit test suite"
  echo "  build      Compile the TypeScript codebase to JS (dist/)"
  echo "  clean      Clean build folders (dist/)"
  echo "  help       Show this help information"
  echo ""
  echo "Examples:"
  echo "  $0 start"
  echo "  $0 test"
}

# Main command router
case "${1:-help}" in
  start)
    show_header
    echo -e "${GREEN}🚀 Starting Stratum Daemon in foreground mode...${NC}"
    echo -e "${YELLOW}Server will be available at http://localhost:7700${NC}\n"
    npx tsx src/cli.ts start --foreground
    ;;
  test)
    show_header
    echo -e "${BLUE}🧪 Running universal test suite...${NC}\n"
    npm run test
    ;;
  build)
    show_header
    echo -e "${GREEN}⚙️ Compiling TypeScript codebase...${NC}"
    npm run build
    echo -e "${GREEN}✓ Compilation completed successfully!${NC}"
    ;;
  clean)
    show_header
    echo -e "${YELLOW}🧹 Cleaning build directories...${NC}"
    npm run clean
    echo -e "${GREEN}✓ Clean completed!${NC}"
    ;;
  help|--help|-h)
    show_help
    ;;
  *)
    echo -e "${RED}Error: Unknown command '$1'${NC}"
    show_help
    exit 1
    ;;
esac
