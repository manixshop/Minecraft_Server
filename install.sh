#!/bin/bash
clear

# ==========================================
# 🌟 COLOR CODES
# ==========================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m'

echo -e "${GREEN}==========================================================${NC}"
echo -e "${WHITE}  🎮 MINECRAFT PANEL INSTALLER                          ${NC}"
echo -e "${GREEN}==========================================================${NC}"
echo ""

# Auto-detect sudo
[ "$(id -u)" -eq 0 ] && SUDO_CMD="" || SUDO_CMD="sudo"

PANEL_DIR="/opt/minecraft-panel"
PANEL_PORT=${1:-8080}
MC_PORT=${2:-25565}

echo -e "${YELLOW}📋 Configuration:${NC}"
echo -e "  Panel Directory : ${CYAN}${PANEL_DIR}${NC}"
echo -e "  Panel Port      : ${CYAN}${PANEL_PORT}${NC}"
echo -e "  MC Default Port : ${CYAN}${MC_PORT}${NC}"
echo ""

# ==========================================
# STEP 1: Install Dependencies
# ==========================================
echo -e "${YELLOW}⏳ Step 1/6: Installing system dependencies...${NC}"
$SUDO_CMD apt-get update -y > /dev/null 2>&1
$SUDO_CMD apt-get install -y curl wget git build-essential ufw unzip screen tmux > /dev/null 2>&1
echo -e "${GREEN}  ✅ System dependencies installed${NC}"

# ==========================================
# STEP 2: Install Java (8, 17, 21)
# ==========================================
echo -e "${YELLOW}⏳ Step 2/6: Installing Java versions...${NC}"
$SUDO_CMD apt-get install -y openjdk-17-jdk openjdk-21-jdk > /dev/null 2>&1
# Java 8 if available
$SUDO_CMD apt-get install -y openjdk-8-jdk > /dev/null 2>&1 || echo -e "  ${YELLOW}⚠️ Java 8 not available (optional)${NC}"
echo -e "${GREEN}  ✅ Java installed${NC}"
java -version 2>&1 | head -1

# ==========================================
# STEP 3: Install Node.js
# ==========================================
echo -e "${YELLOW}⏳ Step 3/6: Installing Node.js...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO_CMD bash - > /dev/null 2>&1
    $SUDO_CMD apt-get install -y nodejs > /dev/null 2>&1
fi
echo -e "${GREEN}  ✅ Node.js $(node -v) installed${NC}"

# ==========================================
# STEP 4: Install MySQL/MariaDB (Optional)
# ==========================================
echo -e "${YELLOW}⏳ Step 4/6: Installing MariaDB...${NC}"
$SUDO_CMD apt-get install -y mariadb-server mariadb-client > /dev/null 2>&1
$SUDO_CMD systemctl enable mariadb > /dev/null 2>&1
$SUDO_CMD systemctl start mariadb > /dev/null 2>&1
echo -e "${GREEN}  ✅ MariaDB installed${NC}"

# ==========================================
# STEP 5: Setup Panel
# ==========================================
echo -e "${YELLOW}⏳ Step 5/6: Setting up panel...${NC}"

$SUDO_CMD mkdir -p "$PANEL_DIR"
$SUDO_CMD chown -R $(whoami):$(whoami) "$PANEL_DIR" 2>/dev/null

# Copy files
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp -r "$SCRIPT_DIR/package.json" "$PANEL_DIR/" 2>/dev/null
cp -r "$SCRIPT_DIR/server.js" "$PANEL_DIR/" 2>/dev/null
mkdir -p "$PANEL_DIR/public"
cp -r "$SCRIPT_DIR/public/"* "$PANEL_DIR/public/" 2>/dev/null
mkdir -p "$PANEL_DIR/data" "$PANEL_DIR/backups" "$PANEL_DIR/servers" "$PANEL_DIR/uploads"

cd "$PANEL_DIR"
echo -e "  ${CYAN}Installing npm packages...${NC}"
npm install --production > /dev/null 2>&1
echo -e "${GREEN}  ✅ Panel setup complete${NC}"

# ==========================================
# STEP 6: Open Ports & Create Service
# ==========================================
echo -e "${YELLOW}⏳ Step 6/6: Configuring firewall & service...${NC}"

# Open ports
$SUDO_CMD ufw allow ${PANEL_PORT}/tcp > /dev/null 2>&1
$SUDO_CMD ufw allow ${MC_PORT}/tcp > /dev/null 2>&1
# Open common MC ports
for p in 25565 25566 25567 25568 25569 25570; do
    $SUDO_CMD ufw allow ${p}/tcp > /dev/null 2>&1
done
$SUDO_CMD ufw allow 8080/tcp > /dev/null 2>&1
$SUDO_CMD ufw allow 3000/tcp > /dev/null 2>&1
$SUDO_CMD ufw allow 443/tcp > /dev/null 2>&1
$SUDO_CMD ufw allow 80/tcp > /dev/null 2>&1
$SUDO_CMD ufw --force enable > /dev/null 2>&1
echo -e "${GREEN}  ✅ Ports opened${NC}"

# Create systemd service
$SUDO_CMD tee /etc/systemd/system/minecraft-panel.service > /dev/null <<EOF
[Unit]
Description=Minecraft Panel
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${PANEL_DIR}
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PANEL_PORT=${PANEL_PORT}

[Install]
WantedBy=multi-user.target
EOF

$SUDO_CMD systemctl daemon-reload
$SUDO_CMD systemctl enable minecraft-panel > /dev/null 2>&1
$SUDO_CMD systemctl start minecraft-panel

sleep 3

# Get IP addresses
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 icanhazip.com 2>/dev/null || echo "YOUR_IP")
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

# Check if running
if $SUDO_CMD systemctl is-active --quiet minecraft-panel; then
    PANEL_STATUS="${GREEN}RUNNING${NC}"
else
    PANEL_STATUS="${RED}FAILED${NC}"
fi

# ==========================================
# FINAL OUTPUT
# ==========================================
clear
echo -e "${GREEN}==========================================================${NC}"
echo -e "${WHITE}  🎮 MINECRAFT PANEL - INSTALLATION COMPLETE!            ${NC}"
echo -e "${GREEN}==========================================================${NC}"
echo ""
echo -e "${WHITE}  📊 STATUS: ${PANEL_STATUS}${NC}"
echo ""
echo -e "${PURPLE}==========================================================${NC}"
echo -e "${WHITE}  🌐 PANEL ADDRESS:${NC}"
echo -e "${CYAN}     http://${PUBLIC_IP}:${PANEL_PORT}${NC}"
echo -e "${CYAN}     http://${LOCAL_IP}:${PANEL_PORT}${NC}"
echo ""
echo -e "${WHITE}  🎮 MINECRAFT SERVER ADDRESS:${NC}"
echo -e "${CYAN}     ${PUBLIC_IP}:${MC_PORT}${NC}"
echo ""
echo -e "${WHITE}  👤 DEFAULT LOGIN:${NC}"
echo -e "${YELLOW}     Username: admin${NC}"
echo -e "${YELLOW}     Password: admin123${NC}"
echo ""
echo -e "${WHITE}  ⚙️  PANEL DIRECTORY: ${CYAN}${PANEL_DIR}${NC}"
echo -e "${WHITE}  📺 SERVICE COMMANDS:${NC}"
echo -e "     ${CYAN}sudo systemctl start minecraft-panel${NC}"
echo -e "     ${CYAN}sudo systemctl stop minecraft-panel${NC}"
echo -e "     ${CYAN}sudo systemctl restart minecraft-panel${NC}"
echo -e "     ${CYAN}sudo journalctl -u minecraft-panel -f${NC}"
echo ""
echo -e "${WHITE}  🔥 OPEN PORTS:${NC}"
echo -e "     Panel: ${CYAN}${PANEL_PORT}${NC}"
echo -e "     MC:    ${CYAN}25565-25570${NC}"
echo -e "     HTTP:  ${CYAN}80, 443${NC}"
echo ""
echo -e "${PURPLE}==========================================================${NC}"
echo -e "${GREEN}  ✅ Ready! Open the panel address in your browser.${NC}"
echo -e "${GREEN}==========================================================${NC}"