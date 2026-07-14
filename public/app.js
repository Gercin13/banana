// Nano Studio — frontend (vanilla JS, no build step).
const $ = (s) => document.querySelector(s);

const state = {
  genMode: "image", // "image" or "video"
  aspect: "1:1",
  count: 1,
  tier: "draft",
  size: "1K",
  aspects: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"],
  tiers: [{ id: "lite", label: "Быстро" }, { id: "draft", label: "Черновик" }, { id: "quality", label: "Качество" }],
  sizes: ["1K", "2K"],
  maxImages: 4,
  maxRefs: 10,
  faceRefs: [],
  poseRefs: [],
  garmentRefs: [],
  productRefs: [],
  backgroundRefs: [],
  editImage: null, // { mimeType, dataBase64, thumbUrl } — for pure image editing
  videoFirstFrame: null, // { mimeType, dataBase64, thumbUrl }
  videoLastFrame: null,  // { mimeType, dataBase64, thumbUrl }
  videoDuration: 5,      // 5 or 8 seconds
  characterId: "",
  characters: [],
  busy: false,
};

const els = {
  prompt: $("#prompt"), mic: $("#mic"),
  aspects: $("#aspects"), counts: $("#counts"), tiers: $("#tiers"), sizes: $("#sizes"),
  generate: $("#generate"), status: $("#status"),
  gallery: $("#gallery"), history: $("#history"), refreshHistory: $("#refresh-history"),
  refsNote: $("#refs-note"), enhanceRow: $("#enhance-row"), enhance: $("#enhance"),
  attach: $("#attach"), attachInput: $("#attach-input"),
  editPreview: $("#edit-preview"), editThumb: $("#edit-thumb"), editRemove: $("#edit-remove"),
  character: $("#character"), saveChar: $("#save-char"), delChar: $("#del-char"), charPreview: $("#char-preview"),
  cost: $("#cost-estimate"),
  modeImage: $("#mode-image"), modeVideo: $("#mode-video"),
  settingsImage: $("#settings-image"), settingsVideo: $("#settings-video"),
  vfirstDrop: $("#vfirst-drop"), vfirstInput: $("#vfirst-input"), vfirstThumbs: $("#vfirst-thumbs"),
  vlastDrop: $("#vlast-drop"), vlastInput: $("#vlast-input"), vlastThumbs: $("#vlast-thumbs"),
  vdurations: $("#vdurations"), negPrompt: $("#neg-prompt"),
};

// Rough per-image cost estimate (USD, WaveSpeed ~2026) — for display only.
const PRICES = {
  lite:    { "1K": 0.015, "2K": 0.015 },
  draft:   { "1K": 0.045, "2K": 0.09 },
  quality: { "1K": 0.045, "2K": 0.09 },
};
const VIDEO_PRICES = { 5: 0.15, 8: 0.24 }; // rough estimate for WAN 2.2 i2v
function updateCost() {
  if (!els.cost) return;
  if (state.genMode === "video") {
    const vp = VIDEO_PRICES[state.videoDuration] || 0.15;
    els.cost.textContent = `≈ $${vp.toFixed(2)} за видео (${state.videoDuration} сек) · оценка`;
  } else {
    const per = (PRICES[state.tier] && PRICES[state.tier][state.size]) || 0;
    els.cost.textContent = `≈ $${(per * state.count).toFixed(2)} за генерацию · оценка`;
  }
}

// ---- Controls -------------------------------------------------------------
function renderAspects() {
  els.aspects.innerHTML = "";
  for (const a of state.aspects) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill" + (a === state.aspect ? " active" : "");
    b.textContent = a;
    b.onclick = () => { state.aspect = a; renderAspects(); };
    els.aspects.appendChild(b);
  }
}
function renderCounts() {
  els.counts.innerHTML = "";
  for (let i = 1; i <= state.maxImages; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg" + (i === state.count ? " active" : "");
    b.textContent = String(i);
    b.onclick = () => { state.count = i; renderCounts(); updateCost(); };
    els.counts.appendChild(b);
  }
}
function renderTiers() {
  els.tiers.innerHTML = "";
  for (const t of state.tiers) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg" + (t.id === state.tier ? " active" : "");
    b.textContent = t.label;
    b.onclick = () => {
      state.tier = t.id;
      if (t.id === "lite") state.size = "1K"; // Lite supports 1K only
      renderTiers(); renderSizes(); updateCost();
    };
    els.tiers.appendChild(b);
  }
}
function renderSizes() {
  els.sizes.innerHTML = "";
  const liteLock = state.tier === "lite"; // Lite supports 1K only
  for (const s of state.sizes) {
    const b = document.createElement("button");
    b.type = "button";
    const disabled = liteLock && s !== "1K";
    b.className = "seg" + (s === state.size ? " active" : "") + (disabled ? " disabled" : "");
    b.textContent = s;
    if (!disabled) b.onclick = () => { state.size = s; renderSizes(); updateCost(); };
    els.sizes.appendChild(b);
  }
}

// ---- Mode toggle (Image / Video) ------------------------------------------
function setMode(mode) {
  state.genMode = mode;
  if (els.modeImage) els.modeImage.className = "mode-btn" + (mode === "image" ? " active" : "");
  if (els.modeVideo) els.modeVideo.className = "mode-btn" + (mode === "video" ? " active" : "");
  if (els.settingsImage) els.settingsImage.hidden = mode !== "image";
  if (els.settingsVideo) els.settingsVideo.hidden = mode !== "video";
  if (mode === "video") renderDurations();
  els.prompt.placeholder = mode === "video"
    ? "Опишите, что должно происходить в видео…  (Ctrl / ⌘ + Enter — сгенерировать)"
    : "Опишите изображение — или оставьте пустым, и я соберу из референсов.  (Ctrl / ⌘ + Enter — сгенерировать)";
  updateCost();
}
function setupModeToggle() {
  if (els.modeImage) els.modeImage.onclick = () => setMode("image");
  if (els.modeVideo) els.modeVideo.onclick = () => setMode("video");
}

// ---- Video frame uploads --------------------------------------------------
function renderVideoThumb(stateKey, thumbsEl) {
  if (!thumbsEl) return;
  thumbsEl.innerHTML = "";
  const ref = state[stateKey];
  if (!ref) return;
  const t = document.createElement("div"); t.className = "thumb";
  const im = document.createElement("img"); im.src = ref.thumbUrl; im.alt = "";
  const rm = document.createElement("button");
  rm.className = "rm"; rm.type = "button"; rm.textContent = "×";
  rm.onclick = (e) => { e.stopPropagation(); state[stateKey] = null; renderVideoThumb(stateKey, thumbsEl); };
  t.append(im, rm);
  thumbsEl.appendChild(t);
}
function setupVideoFrameZone(stateKey, drop, input, thumbs) {
  if (!drop) return;
  drop.addEventListener("click", (e) => { if (!e.target.closest(".rm")) input.click(); });
  input.addEventListener("change", async () => {
    const f = input.files[0]; input.value = "";
    if (!f || !f.type.startsWith("image/")) return;
    try { state[stateKey] = await fileToRef(f); } catch { return; }
    renderVideoThumb(stateKey, thumbs);
  });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault(); drop.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (!f || !f.type.startsWith("image/")) return;
    try { state[stateKey] = await fileToRef(f); } catch { return; }
    renderVideoThumb(stateKey, thumbs);
  });
}
function setupVideoFrames() {
  setupVideoFrameZone("videoFirstFrame", els.vfirstDrop, els.vfirstInput, els.vfirstThumbs);
  setupVideoFrameZone("videoLastFrame", els.vlastDrop, els.vlastInput, els.vlastThumbs);
}

// ---- Video duration selector -----------------------------------------------
function renderDurations() {
  if (!els.vdurations) return;
  els.vdurations.innerHTML = "";
  for (const d of [5, 8]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg" + (d === state.videoDuration ? " active" : "");
    b.textContent = d + " сек";
    b.onclick = () => { state.videoDuration = d; renderDurations(); updateCost(); };
    els.vdurations.appendChild(b);
  }
}

// ---- Capabilities (from backend, with fallback) ---------------------------
async function loadCapabilities() {
  try {
    const d = await (await fetch("/api/health")).json();
    if (Array.isArray(d.aspectRatios) && d.aspectRatios.length) state.aspects = d.aspectRatios;
    if (Array.isArray(d.imageSizes) && d.imageSizes.length) state.sizes = d.imageSizes;
    if (Number.isInteger(d.maxImages)) state.maxImages = d.maxImages;
    // Show the Atomesus toggle only when the server has the key configured.
    if (d.atomesusEnhance && els.enhanceRow) els.enhanceRow.hidden = false;
  } catch { /* keep defaults */ }
  renderAspects(); renderCounts(); renderTiers(); renderSizes(); renderDurations(); updateCost();
}

// ---- Voice input (optional; hidden if unsupported) ------------------------
function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { els.mic.style.display = "none"; return; }
  const rec = new SR();
  rec.lang = navigator.language || "ru-RU";
  rec.interimResults = true;
  rec.continuous = false;
  let base = "", listening = false;
  rec.onresult = (e) => {
    let txt = "";
    for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
    els.prompt.value = (base ? base + " " : "") + txt;
  };
  const stop = () => { listening = false; els.mic.classList.remove("recording"); };
  rec.onend = stop; rec.onerror = stop;
  els.mic.onclick = () => {
    if (listening) { rec.stop(); return; }
    base = els.prompt.value.trim();
    listening = true; els.mic.classList.add("recording");
    try { rec.start(); } catch { stop(); }
  };
}

// ---- Reference images: three roles (face / pose / garment) ----------------
const ZONES = [
  { key: "faceRefs", drop: "#face-drop", input: "#face-input", thumbs: "#face-thumbs" },
  { key: "poseRefs", drop: "#pose-drop", input: "#pose-input", thumbs: "#pose-thumbs" },
  { key: "garmentRefs", drop: "#garment-drop", input: "#garment-input", thumbs: "#garment-thumbs" },
  { key: "productRefs", drop: "#product-drop", input: "#product-input", thumbs: "#product-thumbs" },
  { key: "backgroundRefs", drop: "#background-drop", input: "#background-input", thumbs: "#background-thumbs" },
];

function totalRefs() {
  return state.faceRefs.length + state.poseRefs.length + state.garmentRefs.length + state.productRefs.length + state.backgroundRefs.length;
}
function updateRefsNote() {
  els.refsNote.textContent = `Референсы опциональны · использовано ${totalRefs()} из ${state.maxRefs}`;
}
function fileToRef(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1024;
      let { width: w, height: h } = img;
      if (w > max || h > max) { const s = Math.min(max / w, max / h); w = Math.round(w * s); h = Math.round(h * s); }
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      const dataUrl = c.toDataURL("image/jpeg", 0.9);
      resolve({ mimeType: "image/jpeg", dataBase64: dataUrl.split(",")[1], thumbUrl: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}
function renderThumbs(zoneKey, thumbsEl) {
  const list = state[zoneKey];
  thumbsEl.innerHTML = "";
  list.forEach((ref, i) => {
    const t = document.createElement("div");
    t.className = "thumb";
    const im = document.createElement("img"); im.src = ref.thumbUrl; im.alt = "";
    const rm = document.createElement("button");
    rm.className = "rm"; rm.type = "button"; rm.textContent = "×"; rm.title = "Удалить";
    rm.onclick = (e) => { e.stopPropagation(); list.splice(i, 1); renderThumbs(zoneKey, thumbsEl); updateRefsNote(); };
    t.append(im, rm);
    thumbsEl.appendChild(t);
  });
}
async function addFiles(zoneKey, thumbsEl, files) {
  for (const f of [...files].filter((f) => f.type.startsWith("image/"))) {
    if (totalRefs() >= state.maxRefs) { els.status.textContent = `Максимум ${state.maxRefs} референсов всего.`; break; }
    try { state[zoneKey].push(await fileToRef(f)); } catch { /* skip bad file */ }
  }
  renderThumbs(zoneKey, thumbsEl);
  updateRefsNote();
}
function setupRefs() {
  for (const z of ZONES) {
    const drop = $(z.drop), input = $(z.input), thumbs = $(z.thumbs);
    if (!drop) continue;
    drop.addEventListener("click", (e) => { if (!e.target.closest(".rm")) input.click(); });
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { addFiles(z.key, thumbs, input.files); input.value = ""; });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("dragover"); addFiles(z.key, thumbs, e.dataTransfer.files); });
  }
}

// ---- Edit image (attach photo to prompt for editing) ----------------------
function renderEditPreview() {
  if (!els.editPreview) return;
  if (state.editImage) {
    els.editThumb.innerHTML = '';
    const img = document.createElement("img"); img.src = state.editImage.thumbUrl; img.alt = "";
    els.editThumb.appendChild(img);
    els.editPreview.hidden = false;
    els.prompt.placeholder = "Опишите, что изменить на фото…  (убрать фон, заменить цвет, удалить объект и т.п.)";
  } else {
    els.editPreview.hidden = true;
    els.editThumb.innerHTML = '';
    els.prompt.placeholder = "Опишите изображение — или оставьте пустым, и я соберу из референсов.  (Ctrl / ⌘ + Enter — сгенерировать)";
  }
}
function setupEditAttach() {
  if (els.attach) els.attach.onclick = () => els.attachInput && els.attachInput.click();
  if (els.attachInput) els.attachInput.onchange = async () => {
    const f = els.attachInput.files[0];
    els.attachInput.value = "";
    if (!f || !f.type.startsWith("image/")) return;
    try { state.editImage = await fileToRef(f); } catch { return; }
    renderEditPreview();
  };
  if (els.editRemove) els.editRemove.onclick = () => { state.editImage = null; renderEditPreview(); };
}

// ---- Saved characters (a named set of face references) --------------------
async function loadCharacters() {
  try {
    const d = await (await fetch("/api/characters")).json();
    state.characters = d.items || [];
  } catch { state.characters = []; }
  renderCharacterOptions();
  renderCharPreview();
}
function renderCharacterOptions() {
  if (!els.character) return;
  els.character.innerHTML = '<option value="">— не выбран —</option>';
  for (const c of state.characters) {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.name || "(без имени)";
    els.character.appendChild(o);
  }
  els.character.value = state.characterId || "";
}
function renderCharPreview() {
  if (!els.charPreview) return;
  const c = state.characters.find((x) => x.id === state.characterId);
  els.charPreview.innerHTML = "";
  if (els.delChar) els.delChar.hidden = !c;
  if (!c) return;
  for (const im of (c.images || []).slice(0, 8)) {
    const t = document.createElement("div");
    t.className = "thumb static";
    const img = document.createElement("img"); img.src = im.url; img.alt = "";
    t.appendChild(img);
    els.charPreview.appendChild(t);
  }
}
async function saveCharacterAction() {
  if (!state.faceRefs.length) {
    els.status.textContent = "Сначала добавьте фото в зону «Лицо / личность».";
    return;
  }
  const name = (window.prompt("Название персонажа:") || "").trim();
  if (!name) return;
  els.status.textContent = "Сохраняю персонажа…";
  try {
    const r = await fetch("/api/characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, faceRefs: refsPayload("faceRefs") }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Не удалось сохранить");
    await loadCharacters();
    state.characterId = d.id;
    renderCharacterOptions();
    renderCharPreview();
    // Face now comes from the saved character — clear the upload zone.
    state.faceRefs = [];
    renderThumbs("faceRefs", $("#face-thumbs"));
    updateRefsNote();
    els.status.textContent = `Персонаж «${name}» сохранён и выбран.`;
  } catch (e) {
    els.status.textContent = "⚠ " + (e.message || e);
  }
}
async function deleteCharacterAction() {
  if (!state.characterId) return;
  const c = state.characters.find((x) => x.id === state.characterId);
  if (!window.confirm(`Удалить персонажа «${c ? c.name : ""}»?`)) return;
  try { await fetch(`/api/characters/${state.characterId}`, { method: "DELETE" }); } catch {}
  state.characterId = "";
  await loadCharacters();
}
function setupCharacters() {
  if (els.character) els.character.onchange = () => { state.characterId = els.character.value; renderCharPreview(); };
  if (els.saveChar) els.saveChar.onclick = saveCharacterAction;
  if (els.delChar) els.delChar.onclick = deleteCharacterAction;
}

// ---- Image cards + rendering ----------------------------------------------
function mediaCard(url, { downloadName, onDelete, isVideo } = {}) {
  const card = document.createElement("div");
  card.className = "card";
  if (isVideo) {
    const vid = document.createElement("video");
    vid.src = url; vid.controls = true; vid.loop = true; vid.muted = true;
    vid.autoplay = true; vid.playsInline = true; vid.preload = "metadata";
    card.appendChild(vid);
  } else {
    const view = document.createElement("a");
    view.href = url; view.target = "_blank"; view.rel = "noopener noreferrer";
    const im = document.createElement("img");
    im.src = url; im.alt = ""; im.loading = "lazy";
    view.appendChild(im);
    card.appendChild(view);
  }
  const dl = document.createElement("a");
  dl.className = "download"; dl.href = url; dl.download = downloadName || "";
  dl.textContent = "Скачать";
  card.appendChild(dl);
  if (onDelete) {
    const del = document.createElement("button");
    del.className = "del"; del.type = "button"; del.textContent = "×"; del.title = "Удалить";
    del.onclick = onDelete;
    card.appendChild(del);
  }
  return card;
}
// Backward compat alias
function imageCard(url, opts) { return mediaCard(url, opts); }
function showEmpty() {
  els.gallery.innerHTML = '<div class="empty">Здесь появятся сгенерированные изображения</div>';
}
function skeletons(n) {
  els.gallery.innerHTML = "";
  for (let i = 0; i < n; i++) { const d = document.createElement("div"); d.className = "card skeleton"; els.gallery.appendChild(d); }
}
function renderResults(images, mode) {
  els.gallery.innerHTML = "";
  const isVideo = mode === "video";
  images.forEach((img, i) => {
    const ext = isVideo ? "mp4" : "png";
    els.gallery.appendChild(mediaCard(img.url, { downloadName: `nano-${Date.now()}-${i + 1}.${ext}`, isVideo }));
  });
}

// ---- History --------------------------------------------------------------
async function loadHistory() {
  try {
    const d = await (await fetch("/api/history?limit=200")).json();
    const items = d.items || [];
    els.history.innerHTML = "";
    if (!items.length) { els.history.innerHTML = '<div class="empty">История пуста</div>'; return; }
    for (const rec of items) {
      const isVideo = rec.mode === "video" || (rec.images?.[0]?.mimeType || "").includes("video");
      for (const img of rec.images || []) {
        const ext = isVideo ? "mp4" : "png";
        els.history.appendChild(mediaCard(img.url, {
          downloadName: `nano-${rec.id}.${ext}`,
          isVideo,
          onDelete: async () => {
            try { await fetch(`/api/history/${rec.id}`, { method: "DELETE" }); } catch {}
            loadHistory();
          },
        }));
      }
    }
  } catch { /* ignore */ }
}

// ---- Generate -------------------------------------------------------------
function setBusy(b) {
  state.busy = b;
  els.generate.disabled = b;
  els.generate.textContent = b ? "Генерирую…" : "Сгенерировать";
}
function refsPayload(zoneKey) {
  return state[zoneKey].map((r) => ({ mimeType: r.mimeType, dataBase64: r.dataBase64 }));
}
async function generate() {
  if (state.busy) return;
  const prompt = els.prompt.value.trim();
  // Video mode validations
  if (state.genMode === "video") {
    if (!state.videoFirstFrame) {
      els.status.textContent = "Добавьте изображение первого кадра в настройках.";
      return;
    }
    if (!prompt) {
      els.status.textContent = "Опишите, что должно происходить в видео.";
      els.prompt.focus();
      return;
    }
  }
  // Image mode validations
  if (state.genMode === "image") {
    if (state.editImage && !prompt) {
      els.status.textContent = "Опишите, что изменить на прикреплённом фото.";
      els.prompt.focus();
      return;
    }
    if (!prompt && totalRefs() === 0 && !state.characterId && !state.editImage) {
      els.status.textContent = "Введите промпт, добавьте референс или выберите персонажа.";
      els.prompt.focus();
      return;
    }
  }
  els.status.textContent = "";
  setBusy(true);
  skeletons(state.count);
  try {
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.genMode === "video" ? {
        genMode: "video",
        prompt,
        negativePrompt: els.negPrompt ? els.negPrompt.value.trim() : "",
        duration: state.videoDuration,
        enhance: !!(els.enhance && els.enhance.checked),
        firstFrame: state.videoFirstFrame ? { mimeType: state.videoFirstFrame.mimeType, dataBase64: state.videoFirstFrame.dataBase64 } : null,
        lastFrame: state.videoLastFrame ? { mimeType: state.videoLastFrame.mimeType, dataBase64: state.videoLastFrame.dataBase64 } : null,
      } : {
        genMode: "image",
        prompt,
        aspectRatio: state.aspect, size: state.size, count: state.count, tier: state.tier,
        enhance: !!(els.enhance && els.enhance.checked),
        characterId: state.characterId || "",
        editImage: state.editImage ? { mimeType: state.editImage.mimeType, dataBase64: state.editImage.dataBase64 } : null,
        faceRefs: refsPayload("faceRefs"),
        poseRefs: refsPayload("poseRefs"),
        garmentRefs: refsPayload("garmentRefs"),
        productRefs: refsPayload("productRefs"),
        backgroundRefs: refsPayload("backgroundRefs"),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Ошибка генерации");
    renderResults(d.images, d.mode);
    const bits = [d.mode === "video" ? "Готово: видео" : `Готово: ${d.images.length} изобр.`];
    if (d.mode === "edit") bits.push("режим: редактирование фото");
    else if (d.mode === "auto") bits.push("режим: авто из референсов");
    if (d.enhanced) bits.push("промпт улучшен Atomesus");
    if (d.errors?.length) bits.push(`${d.errors.length} из ${state.count} не удалось`);
    els.status.textContent = bits.join(" · ");
    loadHistory();
  } catch (e) {
    showEmpty();
    els.status.textContent = "⚠ " + (e.message || e);
  } finally {
    setBusy(false);
  }
}

els.generate.onclick = generate;
els.prompt.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate(); });
if (els.refreshHistory) els.refreshHistory.onclick = loadHistory;

loadCapabilities();
setupModeToggle();
setupVoice();
setupRefs();
setupEditAttach();
setupVideoFrames();
setupCharacters();
updateRefsNote();
showEmpty();
loadHistory();
loadCharacters();
