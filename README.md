# Math Study VPN
Meant to be a VPN to bypass restrictions. Super easy to use yourself and easy to redistribute and reuse.

Demo at: https://rtbextreme.net/math-study-vpn/index.html

Change "const PORT = 443;" to change port

How to run a Math Study VPN server:

Run these commands

git clone https://github.com/RTBExtreme/math-study-vpn.git

npm init -y

npm install express url fs compression https

node proxy-server.js

or run for no HTTPS

node proxy-server-nohttps.js
