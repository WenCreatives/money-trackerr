#!/bin/bash

# Script to commit and push changes to GitHub
# Run this with: bash commit-and-push.sh

cd /Applications/XAMPP/xamppfiles/htdocs/money-trackerr

echo "📦 Initializing git repository..."
git init

echo "🔗 Adding remote repository..."
git remote add origin https://github.com/WenCreatives/money-trackerr.git 2>/dev/null || git remote set-url origin https://github.com/WenCreatives/money-trackerr.git

echo "📝 Staging all changes..."
git add .

echo "💾 Committing changes..."
git commit -m "Add welcome block, calendar icon, export dropdown, and custom name change modal

- Added welcome block with personalized greeting and time-based messages
- Implemented calendar icon with binding rings and hover/focus effects
- Consolidated export buttons into dropdown menu
- Replaced browser prompt with custom name change modal
- Improved modal centering and styling with backdrop blur
- Added keyboard navigation support (ESC, Enter)
- Enhanced UI with better spacing and modern design"

echo "🚀 Pushing to GitHub..."
git branch -M main 2>/dev/null
git push -u origin main

echo "✅ Done! Check your GitHub repository to see the changes."
