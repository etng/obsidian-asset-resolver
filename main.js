const { Plugin, PluginSettingTab, Setting, requestUrl } = require("obsidian");

const DEFAULT_SETTINGS = {
  enabled: true,
  failoverDelayMs: 400,
  manifestPath: "",
  localPrefixes: ["../assets/", "./assets/", "assets/"],
  backends: [],
};

module.exports = class AssetResolverPlugin extends Plugin {
  async onload() {
    this.instanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.resolvedUrlCache = new Map();
    this.assetMetadataByRemoteKey = new Map();
    this.assetMetadataByAssetKey = new Map();
    this.settings = this.normalizeSettings(
      Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    );
    await this.loadAssetManifest();

    this.addSettingTab(new AssetResolverSettingTab(this.app, this));
    this.registerMarkdownPostProcessor((el, ctx) => this.processContainer(el, ctx));
    this.app.workspace.onLayoutReady(() => this.processExistingMarkdown());
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.processExistingMarkdown())
    );
    this.registerVaultAssetChangeHandlers();
  }

  normalizeSettings(settings) {
    return {
      enabled: settings.enabled !== false,
      failoverDelayMs: Number(settings.failoverDelayMs) || 400,
      manifestPath: String(settings.manifestPath || "").trim(),
      localPrefixes: this.normalizeLines(settings.localPrefixes).map((prefix) =>
        prefix.replace(/\\/g, "/")
      ),
      backends: this.normalizeBackends(settings.backends),
    };
  }

  normalizeLines(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    return String(value || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  normalizeBackends(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((backend) => this.normalizeBackend(backend))
      .filter(Boolean);
  }

  normalizeBackend(backend) {
    const type = String(
      backend.type || (backend.baseUrl ? "public-url" : "local-sigv4")
    ).trim();
    const name = String(backend.name || "").trim() || "Asset mirror";

    if (type === "public-url") {
      const baseUrl = String(backend.baseUrl || "").trim();
      if (!/^https?:\/\//i.test(baseUrl)) {
        return null;
      }

      return {
        name,
        type,
        baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
      };
    }

    if (type === "local-sigv4") {
      const endpoint = String(backend.endpoint || "").trim().replace(/\/+$/, "");
      const bucket = String(backend.bucket || "").trim();
      const accessKeyId = String(backend.accessKeyId || "").trim();
      const secretAccessKey = String(backend.secretAccessKey || "");
      if (!/^https?:\/\//i.test(endpoint) || !bucket || !accessKeyId || !secretAccessKey) {
        return null;
      }

      return {
        name,
        type,
        endpoint,
        bucket,
        region: String(backend.region || "us-east-1").trim() || "us-east-1",
        keyPrefix: String(backend.keyPrefix || "").trim().replace(/^\/+|\/+$/g, ""),
        accessKeyId,
        secretAccessKey,
        sessionToken: String(backend.sessionToken || "").trim(),
        expiresInSeconds: this.clampExpiresInSeconds(backend.expiresInSeconds),
        forcePathStyle: backend.forcePathStyle !== false,
      };
    }

    return null;
  }

  processExistingMarkdown() {
    if (!this.settings.enabled) {
      return;
    }

    document
      .querySelectorAll(".markdown-preview-view, .markdown-reading-view")
      .forEach((el) => this.processContainer(el));
  }

  registerVaultAssetChangeHandlers() {
    const vault = this.app?.vault;
    if (!vault?.on) {
      return;
    }

    this.registerEvent(
      vault.on("delete", (file) => this.queueProcessIfLocalAssetPath(file?.path))
    );
    this.registerEvent(
      vault.on("rename", (file, oldPath) => {
        this.queueProcessIfLocalAssetPath(file?.path);
        this.queueProcessIfLocalAssetPath(oldPath);
      })
    );
  }

  queueProcessIfLocalAssetPath(path) {
    if (this.isConfiguredLocalAssetPath(path)) {
      this.queueProcessExistingMarkdown();
    }
  }

  queueProcessExistingMarkdown() {
    if (this.processExistingMarkdownTimer) {
      window.clearTimeout(this.processExistingMarkdownTimer);
    }

    this.processExistingMarkdownTimer = window.setTimeout(() => {
      this.processExistingMarkdownTimer = null;
      this.processExistingMarkdown();
    }, 150);
  }

  isConfiguredLocalAssetPath(path) {
    const normalizedPath = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedPath) {
      return false;
    }

    return this.settings.localPrefixes.some((prefix) => {
      const normalizedPrefix = prefix
        .replace(/\\/g, "/")
        .replace(/^(\.\/|\.\.\/)+/, "")
        .replace(/^\/+/, "");
      return normalizedPrefix && normalizedPath.startsWith(normalizedPrefix);
    });
  }

  async loadAssetManifest() {
    this.assetMetadataByRemoteKey = new Map();
    this.assetMetadataByAssetKey = new Map();
    const paths = [
      this.settings.manifestPath,
      `${this.manifest.dir}/asset_manifest.json`,
    ].filter(Boolean);

    for (const path of paths) {
      try {
        const text = await this.app.vault.adapter.read(path);
        const assets = this.assetManifestItemsFromText(text, path);
        for (const item of assets) {
          if (item && item.remote_key) {
            const remoteKey = String(item.remote_key).replace(/^\/+/, "");
            this.assetMetadataByRemoteKey.set(remoteKey, item);
            for (const assetKey of this.assetKeysFromManifestItem(item)) {
              this.assetMetadataByAssetKey.set(assetKey, item);
            }
          }
        }
        if (
          this.assetMetadataByRemoteKey.size > 0 ||
          this.assetMetadataByAssetKey.size > 0
        ) {
          return;
        }
      } catch (error) {
        // Manifest is optional; fall back to path-derived signing.
      }
    }
  }

  assetManifestItemsFromText(text, path) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      return [];
    }

    if (String(path || "").endsWith(".jsonl")) {
      return trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((item) => item && typeof item === "object" && !Array.isArray(item));
    }

    const data = JSON.parse(trimmed);
    if (Array.isArray(data)) {
      return data.filter((item) => item && typeof item === "object");
    }
    return Array.isArray(data.assets) ? data.assets : [];
  }

  assetKeysFromManifestItem(item) {
    const keys = new Set();
    const explicitAssetKey = String(item.asset_key || "").replace(/^\/+/, "");
    if (explicitAssetKey) {
      keys.add(explicitAssetKey);
    }

    const markdownPath = String(item.markdown_path || "");
    const markdownAssetKey = this.assetKeyFromSrc(markdownPath);
    if (markdownAssetKey) {
      keys.add(markdownAssetKey);
    }

    return Array.from(keys);
  }

  sourcePathFromElement(el) {
    let sourcePath = "";
    const workspace = this.app?.workspace;
    if (!workspace?.iterateAllLeaves) {
      return sourcePath;
    }

    workspace.iterateAllLeaves((leaf) => {
      if (sourcePath) {
        return;
      }
      const view = leaf.view;
      if (view?.file?.path && view.containerEl?.contains(el)) {
        sourcePath = view.file.path;
      }
    });

    return sourcePath;
  }

  processContainer(el, ctx = {}) {
    if (!this.settings.enabled) {
      return;
    }

    const sourcePath = ctx?.sourcePath || this.sourcePathFromElement(el);

    el.querySelectorAll("img").forEach((img) => this.prepareImage(img, sourcePath));
    el.querySelectorAll(".internal-embed[src]").forEach((embed) =>
      this.prepareInternalEmbed(embed, sourcePath)
    );
    el.querySelectorAll("a[href], a[data-href]").forEach((link) =>
      this.prepareAssetLink(link, sourcePath)
    );
    this.observeMarkdownContainer(el, sourcePath);
  }

  ensureMarkdownObserverState() {
    if (!this.observedMarkdownContainers) {
      this.observedMarkdownContainers = new WeakSet();
    }
    if (!this.markdownContainerTimers) {
      this.markdownContainerTimers = new WeakMap();
    }
  }

  observeMarkdownContainer(el, sourcePath) {
    this.ensureMarkdownObserverState();
    if (
      typeof MutationObserver !== "function" ||
      this.observedMarkdownContainers.has(el)
    ) {
      return;
    }

    this.observedMarkdownContainers.add(el);
    const observer = new MutationObserver((mutations) => {
      if (this.mutationsAddedElements(mutations)) {
        this.queueProcessContainer(el, sourcePath);
      }
    });
    observer.observe(el, { childList: true, subtree: true });
    this.register?.(() => observer.disconnect());
  }

  mutationsAddedElements(mutations) {
    return mutations.some((mutation) =>
      Array.from(mutation.addedNodes || []).some((node) => node.nodeType === 1)
    );
  }

  queueProcessContainer(el, sourcePath) {
    this.ensureMarkdownObserverState();
    const existingTimer = this.markdownContainerTimers.get(el);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      this.markdownContainerTimers.delete(el);
      this.processContainer(el, { sourcePath });
    }, 50);
    this.markdownContainerTimers.set(el, timer);
  }

  prepareImage(img, sourcePath) {
    const originalSrc = img.dataset.assetResolverOriginalSrc || img.getAttribute("src") || "";
    if (img.dataset.assetResolverBound === this.manifest.id) {
      if (this.localAssetExists(originalSrc, sourcePath)) {
        this.restoreLocalImage(img, originalSrc, sourcePath);
      }
      return;
    }

    const assetKey = this.assetKeyToResolve(originalSrc, sourcePath);
    if (!assetKey) {
      return;
    }

    this.buildCandidateUrls(assetKey)
      .then((candidates) => {
        if (candidates.length > 0) {
          this.bindCandidateImage(img, originalSrc, assetKey, candidates, false);
        }
      })
      .catch((error) => this.logResolverError("failed to prepare image", error));
  }

  prepareInternalEmbed(embed, sourcePath) {
    const originalSrc =
      embed.dataset.assetResolverOriginalSrc || embed.getAttribute("src") || "";
    if (this.localAssetExists(originalSrc, sourcePath)) {
      return;
    }

    if (
      embed.dataset.assetResolverBound === this.manifest.id &&
      embed.querySelector("img.asset-resolver-image")
    ) {
      return;
    }

    const assetKey = this.assetKeyToResolve(originalSrc, sourcePath);
    if (!assetKey) {
      return;
    }

    embed.dataset.assetResolverBound = this.manifest.id;
    embed.dataset.assetResolverOriginalSrc = originalSrc;
    embed.dataset.assetResolverAssetKey = assetKey;

    this.buildCandidateUrls(assetKey)
      .then((candidates) => {
        if (candidates.length > 0) {
          this.scheduleEmbedResolution(embed, originalSrc, assetKey, candidates);
        }
      })
      .catch((error) => this.logResolverError("failed to prepare embed", error));
  }

  scheduleEmbedResolution(embed, originalSrc, assetKey, candidates) {
    [0, 100, 500].forEach((delay) => {
      window.setTimeout(() => {
        this.renderResolvedEmbed(embed, originalSrc, assetKey, candidates);
      }, delay);
    });
  }

  renderResolvedEmbed(embed, originalSrc, assetKey, candidates) {
    if (!embed.isConnected) {
      return;
    }

    const existing = embed.querySelector("img.asset-resolver-image");
    if (
      existing &&
      ["ok", "trying"].includes(existing.dataset.assetResolverStatus)
    ) {
      return;
    }

    embed.textContent = "";

    const img = existing || document.createElement("img");
    img.alt = embed.getAttribute("alt") || assetKey;
    img.classList.add("asset-resolver-image");
    if (!img.parentElement) {
      embed.appendChild(img);
    }

    this.bindCandidateImage(img, originalSrc, assetKey, candidates, true);
  }

  bindCandidateImage(img, originalSrc, assetKey, candidates, startImmediately) {
    img.dataset.assetResolverBound = this.manifest.id;
    img.dataset.assetResolverOriginalSrc = originalSrc;
    img.dataset.assetResolverAssetKey = assetKey;
    img.dataset.assetResolverIndex = "-1";
    img.dataset.assetResolverRefreshCount = "0";

    const tryNext = () => {
      const nextIndex = Number(img.dataset.assetResolverIndex || "-1") + 1;
      if (nextIndex >= candidates.length) {
        this.refreshCandidateImage(img, assetKey, (freshCandidates) => {
          candidates = freshCandidates;
          img.dataset.assetResolverIndex = "-1";
          tryNext();
        });
        return;
      }

      const nextUrl = candidates[nextIndex];
      img.dataset.assetResolverIndex = String(nextIndex);
      img.dataset.assetResolverStatus = "trying";
      img.dataset.assetResolverCurrent = nextUrl;
      img.src = nextUrl;
    };

    img.addEventListener("error", tryNext);
    img.addEventListener("load", () => {
      if (img.naturalWidth > 0) {
        img.dataset.assetResolverStatus = "ok";
      }
    });

    window.setTimeout(() => {
      if (!img.isConnected || img.dataset.assetResolverStatus === "ok") {
        return;
      }

      if (img.complete && img.naturalWidth === 0) {
        tryNext();
      }
    }, this.settings.failoverDelayMs);

    if (startImmediately) {
      tryNext();
    }
  }

  refreshCandidateImage(img, assetKey, onFreshCandidates) {
    const refreshCount = Number(img.dataset.assetResolverRefreshCount || "0");
    if (!assetKey || refreshCount >= 1) {
      img.dataset.assetResolverStatus = "failed";
      return;
    }

    img.dataset.assetResolverRefreshCount = String(refreshCount + 1);
    img.dataset.assetResolverStatus = "refreshing";

    this.buildCandidateUrls(assetKey)
      .then((freshCandidates) => {
        if (!img.isConnected) {
          return;
        }

        if (!freshCandidates.length) {
          img.dataset.assetResolverStatus = "failed";
          return;
        }

        onFreshCandidates(freshCandidates);
      })
      .catch((error) => {
        img.dataset.assetResolverStatus = "failed";
        this.logResolverError("failed to refresh image candidate", error);
      });
  }

  prepareAssetLink(link, sourcePath) {
    const originalHref =
      link.dataset.assetResolverOriginalHref ||
      link.getAttribute("data-href") ||
      link.getAttribute("href") ||
      "";
    if (this.localAssetExists(originalHref, sourcePath)) {
      this.restoreLocalLink(link, originalHref);
      return;
    }

    const assetKey = this.assetKeyToResolve(originalHref, sourcePath);
    if (!assetKey) {
      return;
    }

    link.dataset.assetResolverBound = this.manifest.id;
    link.dataset.assetResolverOriginalHref = originalHref;
    link.dataset.assetResolverAssetKey = assetKey;
    link.classList.add("asset-resolver-link");
    link.dataset.assetResolverStatus = "signing";

    this.buildCandidateUrls(assetKey)
      .then((candidates) => {
        if (candidates.length === 0) {
          link.dataset.assetResolverStatus = "failed";
          return;
        }

        const firstCandidate = candidates[0];
        link.dataset.assetResolverCandidates = JSON.stringify(candidates);
        link.setAttribute("href", firstCandidate);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener");
        link.dataset.assetResolverStatus = "ready";
      })
      .catch((error) => {
        link.dataset.assetResolverStatus = "failed";
        this.logResolverError("failed to prepare link", error);
      });

    if (link.dataset.assetResolverLinkBound === this.instanceId) {
      return;
    }

    link.dataset.assetResolverLinkBound = this.instanceId;
    this.registerDomEvent(link, "click", (event) =>
      this.handleAssetLinkClick(event, link)
    );
  }

  async handleAssetLinkClick(event, link) {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const assetKey = link.dataset.assetResolverAssetKey || "";
    const candidates = assetKey
      ? await this.buildCandidateUrls(assetKey)
      : this.candidatesFromLink(link);
    if (candidates.length === 0) {
      return;
    }

    link.dataset.assetResolverStatus = "resolving";
    const pendingWindow =
      candidates.length > 1 ? window.open("about:blank", "_blank") : null;

    try {
      const resolvedUrl =
        candidates.length === 1 ? candidates[0] : await this.resolveCandidateUrl(candidates);
      if (!resolvedUrl) {
        link.dataset.assetResolverStatus = "failed";
        pendingWindow?.close();
        return;
      }

      link.dataset.assetResolverStatus = "ok";
      link.dataset.assetResolverCurrent = resolvedUrl;
      link.setAttribute("href", resolvedUrl);

      if (pendingWindow) {
        pendingWindow.location.href = resolvedUrl;
      } else {
        window.open(resolvedUrl, "_blank", "noopener");
      }
    } catch (error) {
      link.dataset.assetResolverStatus = "failed";
      pendingWindow?.close();
      console.error("Asset Resolver failed to open link", error);
    }
  }

  candidatesFromLink(link) {
    try {
      const candidates = JSON.parse(link.dataset.assetResolverCandidates || "[]");
      return Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    } catch (error) {
      return [];
    }
  }

  async resolveCandidateUrl(candidates) {
    const cacheKey = candidates.join("\n");
    if (this.resolvedUrlCache.has(cacheKey)) {
      return this.resolvedUrlCache.get(cacheKey);
    }

    for (const url of candidates) {
      if (await this.urlLooksAvailable(url)) {
        this.resolvedUrlCache.set(cacheKey, url);
        return url;
      }
    }

    const fallbackUrl = candidates[0] || "";
    if (fallbackUrl) {
      this.resolvedUrlCache.set(cacheKey, fallbackUrl);
    }
    return fallbackUrl;
  }

  async urlLooksAvailable(url) {
    const attempts = [
      { method: "HEAD" },
      { method: "GET", headers: { Range: "bytes=0-0" } },
    ];

    for (const attempt of attempts) {
      if (await this.tryRequestUrl(url, attempt)) {
        return true;
      }
    }

    return false;
  }

  async tryRequestUrl(url, options) {
    if (typeof requestUrl === "function") {
      try {
        const response = await requestUrl({
          url,
          method: options.method,
          headers: options.headers || {},
        });
        return response.status >= 200 && response.status < 400;
      } catch (error) {
        // Continue to browser fetch fallback below.
      }
    }

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers || {},
      });
      return response.ok || response.status === 206;
    } catch (error) {
      return false;
    }
  }

  assetKeyFromSrc(src) {
    const rawSrc = String(src || "").trim();
    if (!rawSrc || this.shouldSkipSrc(rawSrc)) {
      return "";
    }

    const path = this.pathFromSrc(rawSrc);
    if (!path) {
      return "";
    }

    const normalizedPath = path.replace(/\\/g, "/");
    const withoutRelativePrefix = normalizedPath.replace(/^(\.\/|\.\.\/)+/, "");
    const prefixes = this.settings.localPrefixes;

    for (const prefix of prefixes) {
      const normalizedPrefix = prefix.replace(/^(\.\/|\.\.\/)+/, "");
      if (withoutRelativePrefix.startsWith(normalizedPrefix)) {
        return withoutRelativePrefix.slice(normalizedPrefix.length);
      }
    }

    const assetsIndex = withoutRelativePrefix.lastIndexOf("/assets/");
    if (assetsIndex >= 0) {
      return withoutRelativePrefix.slice(assetsIndex + "/assets/".length);
    }

    if (/^(\.\/|\.\.\/)/.test(normalizedPath)) {
      return this.basename(normalizedPath);
    }

    return "";
  }

  shouldSkipSrc(src) {
    return /^(https?:|data:|blob:|obsidian:)/i.test(src);
  }

  pathFromSrc(src) {
    const withoutHash = src.split("#")[0];
    const withoutQuery = withoutHash.split("?")[0];

    try {
      const parsed = new URL(withoutQuery);
      if (/^https?:$/i.test(parsed.protocol)) {
        return "";
      }

      return decodeURIComponent(parsed.pathname || "");
    } catch (error) {
      try {
        return decodeURIComponent(withoutQuery);
      } catch (decodeError) {
        return withoutQuery;
      }
    }
  }

  basename(path) {
    return String(path || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop() || "";
  }

  shouldResolveAssetReference(src, sourcePath) {
    return Boolean(this.assetKeyToResolve(src, sourcePath));
  }

  assetKeyToResolve(src, sourcePath) {
    const assetKey = this.assetKeyFromSrc(src);
    if (!assetKey || this.localAssetExists(src, sourcePath)) {
      return "";
    }

    return assetKey;
  }

  localAssetExists(src, sourcePath) {
    return Boolean(this.localFileForSrc(src, sourcePath));
  }

  localFileForSrc(src, sourcePath) {
    if (!sourcePath) {
      return null;
    }

    const path = this.pathFromSrc(src);
    if (!path) {
      return null;
    }

    return this.app?.metadataCache?.getFirstLinkpathDest?.(path, sourcePath) || null;
  }

  localResourcePathForSrc(src, sourcePath) {
    const file = this.localFileForSrc(src, sourcePath);
    if (!file) {
      return "";
    }

    try {
      return this.app?.vault?.getResourcePath?.(file) || "";
    } catch (error) {
      return "";
    }
  }

  restoreLocalImage(img, originalSrc, sourcePath) {
    const localResourcePath = this.localResourcePathForSrc(originalSrc, sourcePath);
    if (!localResourcePath) {
      return;
    }

    img.classList.remove("asset-resolver-image");
    delete img.dataset.assetResolverBound;
    delete img.dataset.assetResolverOriginalSrc;
    delete img.dataset.assetResolverAssetKey;
    delete img.dataset.assetResolverIndex;
    delete img.dataset.assetResolverStatus;
    delete img.dataset.assetResolverCurrent;
    img.setAttribute("src", localResourcePath);
  }

  restoreLocalLink(link, originalHref) {
    if (link.dataset.assetResolverOriginalHref) {
      link.setAttribute("href", originalHref);
    }
    link.classList.remove("asset-resolver-link");
    delete link.dataset.assetResolverBound;
    delete link.dataset.assetResolverOriginalHref;
    delete link.dataset.assetResolverAssetKey;
    delete link.dataset.assetResolverStatus;
    delete link.dataset.assetResolverCandidates;
    delete link.dataset.assetResolverCurrent;
  }

  async buildCandidateUrls(assetKey) {
    const remoteKey = this.remoteKeyForAssetKey(assetKey);
    if (!remoteKey) {
      return [];
    }

    const candidates = [];
    for (const backend of this.settings.backends) {
      const url = await this.buildCandidateUrl(backend, remoteKey);
      if (url) {
        candidates.push(url);
      }
    }

    return candidates;
  }

  remoteKeyForAssetKey(assetKey) {
    const normalized = String(assetKey || "").replace(/^\/+/, "");
    if (!normalized) {
      return "";
    }

    if (
      this.assetMetadataByRemoteKey.size === 0 &&
      this.assetMetadataByAssetKey.size === 0
    ) {
      return normalized;
    }

    if (this.assetMetadataByAssetKey.has(normalized)) {
      const item = this.assetMetadataByAssetKey.get(normalized);
      return String(item.remote_key || "").replace(/^\/+/, "");
    }

    if (this.assetMetadataByRemoteKey.has(normalized)) {
      return normalized;
    }

    return "";
  }

  async buildCandidateUrl(backend, assetKey) {
    if (backend.type === "local-sigv4") {
      return this.presignSigV4Url(backend, assetKey);
    }

    return this.buildPublicUrl(backend, assetKey);
  }

  buildPublicUrl(backend, assetKey) {
    const safeKey = assetKey
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");

    return `${backend.baseUrl}${safeKey}`;
  }

  async presignSigV4Url(backend, assetKey) {
    const endpointUrl = new URL(backend.endpoint);
    const objectKey = this.joinObjectKey(backend.keyPrefix, assetKey);
    const now = new Date();
    const amzDate = this.toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const service = "s3";
    const credentialScope = `${dateStamp}/${backend.region}/${service}/aws4_request`;
    const host = this.hostForSigV4(endpointUrl, backend);
    const canonicalUri = this.canonicalUriForSigV4(backend, objectKey);
    const signedHeaders = "host";
    const queryParams = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
      "X-Amz-Credential": `${backend.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(backend.expiresInSeconds),
      "X-Amz-SignedHeaders": signedHeaders,
    };

    if (backend.sessionToken) {
      queryParams["X-Amz-Security-Token"] = backend.sessionToken;
    }

    const canonicalQueryString = this.canonicalQueryString(queryParams);
    const canonicalHeaders = `host:${host}\n`;
    const canonicalRequest = [
      "GET",
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const canonicalRequestHash = await this.sha256Hex(canonicalRequest);
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      canonicalRequestHash,
    ].join("\n");
    const signingKey = await this.sigV4SigningKey(
      backend.secretAccessKey,
      dateStamp,
      backend.region,
      service
    );
    const signature = await this.hmacHex(signingKey, stringToSign);
    const finalQuery = `${canonicalQueryString}&X-Amz-Signature=${signature}`;

    return `${endpointUrl.protocol}//${host}${canonicalUri}?${finalQuery}`;
  }

  joinObjectKey(prefix, assetKey) {
    return [prefix, assetKey]
      .map((part) => String(part || "").replace(/^\/+|\/+$/g, ""))
      .filter(Boolean)
      .join("/");
  }

  hostForSigV4(endpointUrl, backend) {
    if (backend.forcePathStyle) {
      return endpointUrl.host;
    }

    return `${backend.bucket}.${endpointUrl.host}`;
  }

  canonicalUriForSigV4(backend, objectKey) {
    const keyPath = this.encodePathForSigV4(objectKey);
    if (backend.forcePathStyle) {
      return `/${this.encodePathForSigV4(backend.bucket)}/${keyPath}`;
    }

    return `/${keyPath}`;
  }

  canonicalQueryString(params) {
    return Object.keys(params)
      .sort()
      .map((key) => `${this.encodeSigV4(key)}=${this.encodeSigV4(params[key])}`)
      .join("&");
  }

  encodePathForSigV4(path) {
    return String(path || "")
      .split("/")
      .map((part) => this.encodeSigV4(part))
      .join("/");
  }

  encodeSigV4(value) {
    return encodeURIComponent(String(value))
      .replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`
      );
  }

  toAmzDate(date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  }

  clampExpiresInSeconds(value) {
    const expires = Number(value) || 300;
    return Math.max(1, Math.min(604800, Math.floor(expires)));
  }

  async sigV4SigningKey(secretAccessKey, dateStamp, region, service) {
    const kDate = await this.hmacBytes(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = await this.hmacBytes(kDate, region);
    const kService = await this.hmacBytes(kRegion, service);
    return this.hmacBytes(kService, "aws4_request");
  }

  async sha256Hex(text) {
    const digest = await this.cryptoSubtle().digest("SHA-256", this.utf8(text));
    return this.bytesToHex(digest);
  }

  async hmacBytes(key, text) {
    const cryptoKey = await this.cryptoSubtle().importKey(
      "raw",
      this.keyBytes(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return this.cryptoSubtle().sign("HMAC", cryptoKey, this.utf8(text));
  }

  async hmacHex(key, text) {
    return this.bytesToHex(await this.hmacBytes(key, text));
  }

  cryptoSubtle() {
    if (globalThis.crypto?.subtle) {
      return globalThis.crypto.subtle;
    }

    try {
      return require("crypto").webcrypto.subtle;
    } catch (error) {
      throw new Error("WebCrypto is not available for local-sigv4 signing");
    }
  }

  keyBytes(key) {
    if (key instanceof ArrayBuffer) {
      return key;
    }

    if (ArrayBuffer.isView(key)) {
      return key;
    }

    return this.utf8(String(key));
  }

  utf8(text) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(String(text));
    }

    return new (require("util").TextEncoder)().encode(String(text));
  }

  bytesToHex(bytes) {
    return Array.from(new Uint8Array(bytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  logResolverError(message, error) {
    console.error(`Asset Resolver ${message}`, error);
  }

  async saveSettings() {
    this.settings = this.normalizeSettings(this.settings);
    await this.saveData(this.settings);
    await this.loadAssetManifest();
    this.processExistingMarkdown();
  }
};

class AssetResolverSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Enable resolver")
      .setDesc("Try configured mirrors when a local asset cannot load or open.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Local path prefixes")
      .setDesc("One prefix per line.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.localPrefixes.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.localPrefixes = value
              .split(/\r?\n/)
              .map((item) => item.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Asset manifest path")
      .setDesc("Optional JSON manifest. If present, only listed assets are signed.")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/plugins/obsidian-asset-resolver/asset_manifest.json")
          .setValue(this.plugin.settings.manifestPath)
          .onChange(async (value) => {
            this.plugin.settings.manifestPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Mirror base URLs")
      .setDesc("One URL per line. The first available asset is used.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.backends.map((item) => item.baseUrl).join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.backends = value
              .split(/\r?\n/)
              .map((baseUrl, index) => ({
                name: `Asset mirror ${index + 1}`,
                baseUrl: baseUrl.trim(),
              }))
              .filter((item) => item.baseUrl);
            await this.plugin.saveSettings();
          })
      );
  }
}
