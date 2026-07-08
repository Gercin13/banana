// Nano Studio — frontend (vanilla JS, no build step).
const $ = (s) => document.querySelector(s);

const state = {
  aspect: "1:1",
  count: 1,
  tier: "draft",
  size: "1K",
  aspects: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"],
  tiers: [{ id: "draft", label: "Черновик" }, { id: "quality", label: "Качество" }],
  sizes: ["1K", "2K", "4K"],
  maxImages: 4,
  maxRefs: 14,
  faceRefs: [],
  poseRefs: [],
  garmentRefs: [],
  productRefs: [],
  backgroundRefs: [],
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
  character: $("#character"), saveChar: $("#save-char"), delChar: $("#del-char"), charPreview: $("#char-preview"),
};

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
    b.onclick = () => { state.count = i; renderCounts(); };
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
    b.onclick = () => { state.tier = t.id; renderTiers(); };
    els.tiers.appendChild(b);
  }
}
function renderSizes() {
  els.sizes.innerHTML = "";
  for (const s of state.sizes) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg" + (s === state.size ? " active" : "");
    b.textContent = s;
    b.onclick = () => { state.size = s; renderSizes(); };
    els.sizes.appendChild(b);
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
  renderAspects(); renderCounts(); renderTiers(); renderSizes();
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
function imageCard(url, { downloadName, onDelete } = {}) {
  const card = document.createElement("div");
  card.className = "card";
  const view = document.createElement("a");
  view.href = url; view.target = "_blank"; view.rel = "noopener noreferrer";
  const im = document.createElement("img");
  im.src = url; im.alt = ""; im.loading = "lazy";
  view.appendChild(im);
  const dl = document.createElement("a");
  dl.className = "download"; dl.href = url; dl.download = downloadName || "";
  dl.textContent = "Скачать";
  card.append(view, dl);
  if (onDelete) {
    const del = document.createElement("button");
    del.className = "del"; del.type = "button"; del.textContent = "×"; del.title = "Удалить";
    del.onclick = onDelete;
    card.appendChild(del);
  }
  return card;
}
function showEmpty() {
  els.gallery.innerHTML = '<div class="empty">Здесь появятся сгенерированные изображения</div>';
}
function skeletons(n) {
  els.gallery.innerHTML = "";
  for (let i = 0; i < n; i++) { const d = document.createElement("div"); d.className = "card skeleton"; els.gallery.appendChild(d); }
}
function renderResults(images) {
  els.gallery.innerHTML = "";
  images.forEach((img, i) => els.gallery.appendChild(imageCard(img.url, { downloadName: `nano-${Date.now()}-${i + 1}.png` })));
}

// ---- History --------------------------------------------------------------
async function loadHistory() {
  try {
    const d = await (await fetch("/api/history?limit=200")).json();
    const items = d.items || [];
    els.history.innerHTML = "";
    if (!items.length) { els.history.innerHTML = '<div class="empty">История пуста</div>'; return; }
    for (const rec of items) {
      for (const img of rec.images || []) {
        els.history.appendChild(imageCard(img.url, {
          downloadName: `nano-${rec.id}.png`,
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
  if (!prompt && totalRefs() === 0 && !state.characterId) {
    els.status.textContent = "Введите промпт, добавьте референс или выберите персонажа.";
    els.prompt.focus();
    return;
  }
  els.status.textContent = "";
  setBusy(true);
  skeletons(state.count);
  try {
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        aspectRatio: state.aspect, size: state.size, count: state.count, tier: state.tier,
        enhance: !!(els.enhance && els.enhance.checked),
        characterId: state.characterId || "",
        faceRefs: refsPayload("faceRefs"),
        poseRefs: refsPayload("poseRefs"),
        garmentRefs: refsPayload("garmentRefs"),
        productRefs: refsPayload("productRefs"),
        backgroundRefs: refsPayload("backgroundRefs"),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Ошибка генерации");
    renderResults(d.images);
    const bits = [`Готово: ${d.images.length} изобр.`];
    if (d.mode === "auto") bits.push("режим: авто из референсов");
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
setupVoice();
setupRefs();
setupCharacters();
updateRefsNote();
showEmpty();
loadHistory();
loadCharacters();
