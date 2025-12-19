#!/bin/bash

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get version from argument
VERSION=$1

# Validate version argument is provided
if [ -z "$VERSION" ]; then
    echo -e "${RED}Error: Version is required${NC}"
    echo "Usage: npm run publish -- <version>"
    echo "Example: npm run publish -- 0.1.2"
    exit 1
fi

# Validate version format (semver: major.minor.patch with optional pre-release)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    echo -e "${RED}Error: Invalid version format '${VERSION}'${NC}"
    echo "Version must follow semver format: X.Y.Z (e.g., 0.1.2, 1.0.0, 2.1.0-beta.1)"
    exit 1
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")

echo -e "${YELLOW}Current version: ${CURRENT_VERSION}${NC}"
echo -e "${YELLOW}New version: ${VERSION}${NC}"

# Check if the new version is the same as current
if [ "$VERSION" == "$CURRENT_VERSION" ]; then
    echo -e "${RED}Error: New version is the same as current version${NC}"
    exit 1
fi

# Update version in package.json
echo -e "${GREEN}Updating package.json version to ${VERSION}...${NC}"
npm version "$VERSION" --no-git-tag-version

# Commit the version bump
echo -e "${GREEN}Committing version bump...${NC}"
git add package.json
git commit -m "chore: bump version to ${VERSION}"

# Push the commit
echo -e "${GREEN}Pushing commit...${NC}"
git push

# Create GitHub release
echo -e "${GREEN}Creating GitHub release v${VERSION}...${NC}"
gh release create "v${VERSION}" --latest --generate-notes

echo -e "${GREEN}Successfully published version ${VERSION}!${NC}"
