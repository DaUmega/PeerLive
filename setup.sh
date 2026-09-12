#!/bin/bash
set -e

GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${GREEN}[+] Installing npm, node, apache...${NC}"
sudo apt update
sudo apt install -y npm nodejs apache2

echo -e "${GREEN}[+] Running npm install...${NC}"
npm install

echo -e "${GREEN}[+] Installing Certbot (Snap version)...${NC}"
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot

echo -e "${GREEN}[+] Copying .env file...${NC}"
if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "${GREEN}⚠️  Please edit .env with your DuckDNS domain and email before continuing.${NC}"
    exit 1
fi

# Load domain + email from .env
DOMAIN=$(grep CUSTOM_DOMAIN .env | cut -d '=' -f2)
EMAIL=$(grep EMAIL .env | cut -d '=' -f2)

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    echo "❌ Please set CUSTOM_DOMAIN and EMAIL in your .env file."
    exit 1
fi

echo -e "${GREEN}[+] Setting up firewall rules...${NC}"
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT || sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT || sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT

echo -e "${GREEN}[+] Creating systemd service for server.js...${NC}"
SERVICE_FILE="/etc/systemd/system/peerlive.service"

sudo bash -c "cat > $SERVICE_FILE" <<EOL
[Unit]
Description=PeerLive Node.js App
After=network.target

[Service]
ExecStart=/usr/bin/node $(pwd)/server.js
WorkingDirectory=$(pwd)
EnvironmentFile=$(pwd)/.env
Restart=always
User=$USER
Group=$USER

[Install]
WantedBy=multi-user.target
EOL

sudo systemctl daemon-reload
sudo systemctl enable peerlive
sudo systemctl restart peerlive

echo -e "${GREEN}[+] Configuring Apache reverse proxy...${NC}"
APACHE_CONF="/etc/apache2/sites-available/000-default.conf"

sudo cp $APACHE_CONF ${APACHE_CONF}.bak || true

sudo bash -c "cat > $APACHE_CONF" <<EOL
<VirtualHost *:80>
    ServerName $DOMAIN

    ProxyPreserveHost On

    # Route WebSocket upgrade requests (Socket.IO) separately so real-time video/chat signaling works
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8080/\$1 [P,L]

    ProxyPass / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/

    ErrorLog \${APACHE_LOG_DIR}/peerlive_error.log
    CustomLog \${APACHE_LOG_DIR}/peerlive_access.log combined
</VirtualHost>
EOL

# Ensure proxy + websocket + rewrite modules are enabled
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite
sudo systemctl reload apache2
sudo systemctl restart apache2

echo -e "${GREEN}[+] Obtaining SSL certificate with Certbot...${NC}"
sudo certbot --apache -d $DOMAIN -m $EMAIL --agree-tos --non-interactive --redirect

echo -e "${GREEN}[✓] Deployment finished!${NC}"
echo -e "${GREEN}Your PeerLive app should be accessible at: https://$DOMAIN${NC}"
