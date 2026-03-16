#!/bin/bash
echo "🚀 Preparing to push Dyad to GitHub..."
echo "---------------------------------------"

if [ ! -d ".git" ]; then
    echo "Error: Not a git repository."
    exit 1
fi

echo "Please enter your GitHub repository URL (e.g., https://github.com/username/dyad-fork.git):"
read REPO_URL

if [ -z "$REPO_URL" ]; then
    echo "Error: Repository URL cannot be empty."
    exit 1
fi

echo "Configuring remote 'origin'..."
git remote remove origin 2>/dev/null
git remote add origin "$REPO_URL"

git branch -M main

echo "---------------------------------------"
echo "Pushing code to $REPO_URL..."
echo "You may be asked for your GitHub username and password (or PAT)."
echo "---------------------------------------"

git push -u origin main

echo "---------------------------------------"
echo "✅ Done! Your code is on GitHub."
