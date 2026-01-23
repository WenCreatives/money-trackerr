#!/bin/bash

# Script to attempt push using stored credentials
cd /Applications/XAMPP/xamppfiles/htdocs/money-trackerr

echo "🚀 Attempting to push to GitHub..."
echo "If this fails, you'll need to use a Personal Access Token"
echo ""

# Try to push - this might work if credentials are cached
git push -u origin main 2>&1

if [ $? -eq 0 ]; then
  echo "✅ Push successful!"
else
  echo ""
  echo "❌ Push failed. Use one of these options:"
  echo ""
  echo "Option 1: Use token script"
  echo "  bash push-with-token.sh YOUR_TOKEN"
  echo ""
  echo "Option 2: Push manually from terminal"
  echo "  cd /Applications/XAMPP/xamppfiles/htdocs/money-trackerr"
  echo "  git push -u origin main"
  echo "  (Then enter username and token when prompted)"
fi
