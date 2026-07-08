// Nano Studio — frontend logic (vanilla JS, no build step).
const $ = (s) => document.querySelector(s);

const state = {
  aspect: "1:1",
  count: 1,
  tier: "draft",
  aspects: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"],
  tiers: [{ id: "draft", label: "Черновик" }, { id: "quality", label: "Качество" }],
  maxImages: 4,
  maxRefs: 14,
  faceRefs: [],   // [{ mimeType, dataBase64, thumbUrl }]
  otherRefs: [],
  busy: false,
};

const els = {
  prompt: $("#prompt"), mic: $("#mic"), aspects: $("#aspects"),
  counts: $("#counts"), tiers: $("#tiers"), generate: $("#generate"),
  status: $("#status"), gallery: $("#gallery"), refsNote: $("#refs-note"),
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

// ---- Capabilities (from backend, with fallback) ---------------------------
async function loadCapabilities() {
  try {
    const d = await (await fetch("/api/health")).json();
    if (Array.isArray(d.aspectRatios) && d.aspectRatios.length) state.aspects = d.aspectRatios;
    if (Number.isInteger(d.maxImages)) state.maxImages = d.maxImages;
  } catch { /* keep defaults */ }
  renderAspects(); renderCounts(); renderTiers();
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
  rec.onend = stop;
  rec.onerror = stop;

  els.mic.onclick = () => {
    if (listening) { rec.stop(); return; }
    base = els.prompt.value.trim();
    listening = true;
    els.mic.classList.add("recording");
    try { rec.start(); } catch { stop(); }
  };
}

// ---- Reference images (face + other), optional -----------------------------
function totalRefs() { return state.faceRefs.length + state.otherRefs.length; }

function updateRefsNote() {
  els.refsNote.textContent = `Референсы опциональны · использовано ${totalRefs()} из ${state.maxRefs}`;
}

// Downscale to max 1024px and encode as JPEG -> { mimeType, dataBase64, thumbUrl }.
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

function setupRefZone(zoneKey, drop, input, thumbs) {
  drop.addEventListener("click", (e) => { if (!e.target.closest(".rm")) input.click(); });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => { addFiles(zoneKey, thumbs, input.files); input.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("dragover"); addFiles(zoneKey, thumbs, e.dataTransfer.files); });
}

function setupRefs() {
  setupRefZone("faceRefs", $("#face-drop"), $("#face-input"), $("#face-thumbs"));
  setupRefZone("otherRefs", $("#other-drop"), $("#other-input"), $("#other-thumbs"));
}

// ---- Generate -------------------------------------------------------------
function setBusy(b) {
  state.busy = b;
  els.generate.disabled = b;
  els.generate.textContent = b ? "Генерирую…" : "Сгенерировать";
}
function skeletons(n) {
  els.gallery.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const d = document.createElement("div");
    d.className = "card skeleton";
    els.gallery.appendChild(d);
  }
}
function renderImages(images) {
  els.gallery.innerHTML = "";
  images.forEach((img, i) => {
    const src = `data:${img.mimeType};base64,${img.dataBase64}`;
    const card = document.createElement("div");
    card.className = "card";
    const im = document.createElement("img");
    im.src = src; im.alt = `Результат ${i + 1}`; im.loading = "lazy";
    const dl = document.createElement("a");
    dl.className = "download"; dl.href = src;
    dl.download = `nano-studio-${Date.now()}-${i + 1}.png`;
    dl.textContent = "Скачать";
    card.append(im, dl);
    els.gallery.appendChild(card);
  });
}

async function generate() {
  if (state.busy) return;
  const prompt = els.prompt.value.trim();
  if (!prompt) { els.status.textContent = "Введите промпт."; els.prompt.focus(); return; }
  els.status.textContent = "";
  setBusy(true);
  skeletons(state.count);
  try {
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt, aspectRatio: state.aspect, count: state.count, tier: state.tier,
        faceRefs: state.faceRefs.map((r) => ({ mimeType: r.mimeType, dataBase64: r.dataBase64 })),
        otherRefs: state.otherRefs.map((r) => ({ mimeType: r.mimeType, dataBase64: r.dataBase64 })),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Ошибка генерации");
    renderImages(d.images);
    const extra = d.errors?.length ? ` · ${d.errors.length} из ${state.count} не удалось` : "";
    els.status.textContent = `Готово: ${d.images.length} изобр.${extra}`;
  } catch (e) {
    els.gallery.innerHTML = "";
    els.status.textContent = "⚠ " + (e.message || e);
  } finally {
    setBusy(false);
  }
}

els.generate.onclick = generate;
els.prompt.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate();
});

loadCapabilities();
setupVoice();
setupRefs();
updateRefsNote();
