#!/bin/bash

# Script to push to GitHub using a Personal Access Token
# Usage: bash push-with-token.sh YOUR_GITHUB_TOKEN

cd /Applications/XAMPP/xamppfiles/htdocs/money-trackerr

if [ -z "$1" ]; then
  echo "❌ Error: Please provide your GitHub Personal Access Token"
  echo ""
  echo "Usage: bash push-with-token.sh YOUR_TOKEN"
  echo ""
  echo "To create a token:"
  echo "1. Go to https://github.com/settings/tokens"
  echo "2. Click 'Generate new token (classic)'"
  echo "3. Select 'repo' scope"
  echo "4. Copy the token and use it here"
  exit 1
fi

TOKEN=$1
REMOTE_URL="https://${TOKEN}@github.com/WenCreatives/money-trackerr.git"

echo "🔗 Updating remote URL with token..."
git remote set-url origin "$REMOTE_URL"

echo "🚀 Pushing to GitHub..."
git push -u origin main

echo "✅ Done! Removing token from remote URL for security..."
git remote set-url origin https://github.com/WenCreatives/money-trackerr.git

echo "✨ Push complete!"
