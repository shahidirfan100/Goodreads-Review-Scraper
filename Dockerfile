# Specify the base Docker image. No browser is needed for the API-based actor.
FROM apify/actor-node:22

# Copy just package.json and package-lock.json first for caching
COPY --chown=myuser:myuser package*.json Dockerfile ./

# Install NPM packages (production only).
# IMPORTANT: Do NOT use --omit=optional here.
# impit's Rust native binary ships via napi-rs optionalDependencies.
# --omit=optional silently skips the binary and causes runtime crashes.
RUN npm --quiet set progress=false \
    && npm install --omit=dev \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy remaining source code
COPY --chown=myuser:myuser . ./

# Start the actor
CMD npm start --silent
