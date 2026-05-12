// SDL-MCP Configuration Admin Console
// Dependency-free browser UI. The backend remains the authority for validation,
// redaction, conflict detection, backups, and writes.

const SECRET_SENTINEL = "__sdlSecret";
const state = {
  snapshot: null,
  draft: {},
  currentSection: null,
  dirty: [],
  validation: null,
  pendingAction: null,
  token: sessionStorage.getItem("sdlConfigToken") ?? "",
};

const els = {};

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function text(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapePointer(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function decodePointer(pointer) {
  if (!pointer || pointer === "/") return [];
  return pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parentPointer(pointer) {
  const parts = decodePointer(pointer);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).map(escapePointer).join("/");
}

function getByPointer(root, pointer) {
  if (pointer === "/" || pointer === "") return root;
  let current = root;
  for (const part of decodePointer(pointer)) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function ensureParent(root, pointer) {
  const parts = decodePointer(pointer);
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const nextPart = parts[index + 1];
    const shouldBeArray = /^\d+$/.test(nextPart);
    if (Array.isArray(current)) {
      const arrayIndex = Number(part);
      if (current[arrayIndex] === undefined || current[arrayIndex] === null || typeof current[arrayIndex] !== "object") {
        current[arrayIndex] = shouldBeArray ? [] : {};
      }
      current = current[arrayIndex];
    } else {
      if (current[part] === undefined || current[part] === null || typeof current[part] !== "object") {
        current[part] = shouldBeArray ? [] : {};
      }
      current = current[part];
    }
  }
  return { parent: current, key: parts[parts.length - 1] };
}

function setByPointer(root, pointer, value) {
  if (pointer === "/" || pointer === "") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Root config must be a JSON object.");
    state.draft = clone(value);
    return;
  }
  const { parent, key } = ensureParent(root, pointer);
  if (Array.isArray(parent)) parent[Number(key)] = value;
  else parent[key] = value;
}

function deleteByPointer(root, pointer) {
  if (pointer === "/" || pointer === "") return;
  const parts = decodePointer(pointer);
  const parent = getByPointer(root, parentPointer(pointer));
  const key = parts[parts.length - 1];
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else if (parent && typeof parent === "object") delete parent[key];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretPlaceholder(value) {
  return isObject(value) && value[SECRET_SENTINEL] === true;
}

function metadataFor(pointer) {
  const fields = state.snapshot?.metadata?.fields ?? [];
  const exact = fields.find((field) => field.path === pointer);
  if (exact) return exact;
  return fields
    .filter((field) => pointer === field.path || pointer.startsWith(`${field.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function sectionFor(pointer) {
  const sections = state.snapshot?.metadata?.sections ?? [];
  return sections
    .filter((section) => section.path === "/" || pointer === section.path || pointer.startsWith(`${section.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function impactLabel(value) {
  return ({
    appliesImmediately: "applies immediately",
    reconnectClients: "reconnect clients",
    reindexRequired: "reindex required",
    restartRequired: "restart required",
  })[value] ?? value;
}

function shortHash(hash) {
  return hash ? hash.slice(0, 12) : "-";
}

function formatJson(value) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}

function classifyField(pointer, value) {
  const meta = metadataFor(pointer);
  if (meta?.control === "secret" || isSecretPlaceholder(value)) return "secret";
  if (meta?.control === "select") return "select";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string" || value === undefined || value === null) return "string";
  if (Array.isArray(value)) return "array";
  return "object";
}

function diffJson(before, after, pointer = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => diffJson(before[key], after[key], `${pointer}/${escapePointer(key)}`));
  }
  const path = pointer || "/";
  return [{
    path,
    kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    before,
    after,
    section: sectionFor(path)?.id ?? "advanced",
    meta: metadataFor(path),
  }];
}

function computeDirty() {
  state.dirty = diffJson(state.snapshot?.raw ?? {}, state.draft);
  const dirtyPaths = new Set(state.dirty.map((entry) => entry.section));
  $$(".section-button").forEach((button) => {
    const section = button.dataset.section;
    button.classList.toggle("is-dirty", dirtyPaths.has(section));
    const dot = $(".dirty-dot", button);
    if (dot) dot.hidden = !dirtyPaths.has(section);
  });
  els.saveBtn.disabled = state.dirty.length === 0;
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

function showAlert(message, tone = "warn") {
  const el = document.createElement("div");
  el.className = "alert";
  el.dataset.tone = tone;
  el.textContent = message;
  els.alerts.prepend(el);
  while (els.alerts.children.length > 4) els.alerts.lastElementChild.remove();
}

function badge(label, tone) {
  const span = document.createElement("span");
  span.className = "admin-badge";
  if (tone) span.dataset.tone = tone;
  span.textContent = label;
  return span;
}

function renderBadges() {
  els.statusBadges.replaceChildren();
  if (!state.snapshot) return;
  els.statusBadges.append(
    badge(state.validation?.ok ?? state.snapshot.validation.ok ? "valid" : "invalid", state.validation?.ok ?? state.snapshot.validation.ok ? "ok" : "warn"),
    badge(`${state.dirty.length} pending`, state.dirty.length ? "warn" : undefined),
  );
}

function renderSections() {
  const sections = state.snapshot?.metadata?.sections ?? [];
  if (!state.currentSection) state.currentSection = sections[0]?.id ?? "repos";
  els.sectionNav.replaceChildren(...sections.map((section) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "section-button";
    button.dataset.section = section.id;
    button.setAttribute("aria-current", String(section.id === state.currentSection));
    button.innerHTML = `<span>${escapeHtml(section.label)}</span><span class="dirty-dot" hidden></span>`;
    button.addEventListener("click", () => {
      state.currentSection = section.id;
      render();
    });
    return button;
  }));
}

function sectionRootFields(section) {
  const fields = state.snapshot?.metadata?.fields ?? [];
  const sectionFields = fields.filter((field) => field.section === section.id);
  return sectionFields.filter((field) => !sectionFields.some((other) => other.path !== field.path && field.path.startsWith(`${other.path}/`)));
}

function unknownTopLevelKeys() {
  const known = new Set((state.snapshot?.metadata?.fields ?? []).map((field) => decodePointer(field.path)[0]).filter(Boolean));
  for (const section of state.snapshot?.metadata?.sections ?? []) {
    const key = decodePointer(section.path)[0];
    if (key) known.add(key);
  }
  return Object.keys(state.draft).filter((key) => !known.has(key));
}

function collectLeaves(value, pointer, max = 80, leaves = []) {
  if (leaves.length >= max) return leaves;
  if (!isObject(value) && !Array.isArray(value)) {
    leaves.push({ pointer, value });
    return leaves;
  }
  if (isSecretPlaceholder(value)) {
    leaves.push({ pointer, value });
    return leaves;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeaves(item, `${pointer}/${index}`, max, leaves));
    return leaves;
  }
  for (const [key, child] of Object.entries(value)) {
    collectLeaves(child, `${pointer}/${escapePointer(key)}`, max, leaves);
  }
  return leaves;
}

function renderSection() {
  const section = (state.snapshot?.metadata?.sections ?? []).find((entry) => entry.id === state.currentSection)
    ?? state.snapshot?.metadata?.sections?.[0];
  if (!section) return;

  $$(".section-button").forEach((button) => button.setAttribute("aria-current", String(button.dataset.section === section.id)));
  els.sectionEyebrow.textContent = section.path;
  els.sectionTitle.textContent = section.label;
  els.sectionDescription.textContent = section.description;
  els.sectionBody.replaceChildren();

  if (section.id === "advanced") {
    renderAdvancedSection(section);
    return;
  }

  const fields = sectionRootFields(section);
  if (fields.length === 0) {
    els.sectionBody.append(renderFieldCard({
      path: section.path,
      label: section.label,
      description: section.description,
      control: "object",
      impact: [],
    }));
    return;
  }

  for (const field of fields) els.sectionBody.append(renderFieldCard(field));
  if (section.path !== "/" && !fields.some((field) => field.path === section.path)) {
    els.sectionBody.append(renderSectionRawFallback(section));
  }
}

function renderSectionRawFallback(section) {
  const card = document.createElement("article");
  card.className = "field-card";
  const value = getByPointer(state.draft, section.path) ?? {};
  card.innerHTML = `<div class="field-head"><span class="field-title">${escapeHtml(section.label)} Raw JSON</span></div>
    <p class="field-desc">Fallback editor for section keys that do not have dedicated controls yet.</p>`;
  card.append(renderRawEditor(section.path, `${section.label} JSON`, value));
  return card;
}

function renderAdvancedSection(section) {
  const keys = unknownTopLevelKeys();
  const wrapper = document.createElement("div");
  wrapper.className = "field-card";
  wrapper.innerHTML = `<div class="field-head"><span class="field-title">Unknown Raw Keys</span></div>
    <p class="field-desc">Unknown keys are preserved on save. SDL-MCP ignores keys it does not recognize.</p>`;
  const list = document.createElement("div");
  list.className = "form-grid";
  if (keys.length === 0) {
    list.innerHTML = `<p class="muted">No unknown top-level keys in the active config.</p>`;
  } else {
    for (const key of keys) list.append(renderRawEditor(`/${escapePointer(key)}`, key, getByPointer(state.draft, `/${escapePointer(key)}`)));
  }
  wrapper.append(list);
  els.sectionBody.append(wrapper);

  const raw = renderRawEditor("/", "Full JSON", state.draft);
  raw.classList.add("full-width");
  els.sectionBody.append(raw);
}

function renderFieldCard(field) {
  const value = getByPointer(state.draft, field.path);
  const effective = getByPointer(state.snapshot?.effective, field.path);
  const card = document.createElement("article");
  card.className = "field-card";

  const head = document.createElement("div");
  head.className = "field-head";
  head.innerHTML = `<span class="field-title">${escapeHtml(field.label)}</span>`;
  const badges = document.createElement("div");
  badges.className = "badge-row";
  for (const item of field.impact ?? []) badges.append(badge(impactLabel(item), item === "appliesImmediately" ? "ok" : undefined));
  if (field.highRisk) badges.append(badge("high risk", "warn"));
  head.append(badges);
  card.append(head);

  const desc = document.createElement("p");
  desc.className = "field-desc";
  desc.textContent = field.description;
  card.append(desc);

  const control = classifyField(field.path, value);
  if (control === "object" || control === "array") {
    const leaves = collectLeaves(value ?? (control === "array" ? [] : {}), field.path);
    if (leaves.length > 0) {
      const grid = document.createElement("div");
      grid.className = "form-grid";
      for (const leaf of leaves) grid.append(renderPrimitiveControl(leaf.pointer, leaf.value));
      card.append(grid);
    }
    card.append(renderRawEditor(field.path, `${field.label} JSON`, value ?? (control === "array" ? [] : {})));
  } else {
    card.append(renderPrimitiveControl(field.path, value, field));
  }

  if (effective !== undefined) {
    const eff = document.createElement("div");
    eff.className = "effective";
    eff.textContent = `effective: ${JSON.stringify(effective)}`;
    card.append(eff);
  }
  return card;
}

function renderPrimitiveControl(pointer, value, explicitMeta) {
  const meta = explicitMeta ?? metadataFor(pointer) ?? {};
  if (isSecretPlaceholder(value) || meta.control === "secret") return renderSecretControl(pointer, value, meta);

  const label = pointer === "/" ? "root" : decodePointer(pointer).slice(-2).join(" / ");
  const kind = classifyField(pointer, value);
  const control = document.createElement("div");
  control.className = `control control-${kind}`;

  const labelEl = document.createElement("label");
  labelEl.textContent = meta.label ?? label;
  control.append(labelEl);

  if (meta.options?.length) {
    const select = document.createElement("select");
    select.value = value ?? "";
    select.append(new Option("not authored", ""));
    for (const option of meta.options) select.append(new Option(option, option));
    select.addEventListener("change", () => {
      if (select.value === "") deleteByPointer(state.draft, pointer);
      else setByPointer(state.draft, pointer, select.value);
      afterDraftChange();
    });
    control.append(select);
    return control;
  }

  if (kind === "boolean") {
    control.classList.add("toggle-row");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(value);
    input.addEventListener("change", () => {
      setByPointer(state.draft, pointer, input.checked);
      afterDraftChange();
    });
    control.append(input);
    return control;
  }

  if (kind === "number") {
    const input = document.createElement("input");
    input.type = "number";
    input.value = value ?? "";
    input.addEventListener("change", () => {
      if (input.value === "") deleteByPointer(state.draft, pointer);
      else setByPointer(state.draft, pointer, Number(input.value));
      afterDraftChange();
    });
    control.append(input);
    return control;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.value = typeof value === "string" ? value : value == null ? "" : String(value);
  input.placeholder = value === undefined ? "not authored" : "";
  if (meta.pathLike) input.autocomplete = "off";
  input.addEventListener("change", () => {
    if (input.value === "" && value === undefined) deleteByPointer(state.draft, pointer);
    else setByPointer(state.draft, pointer, input.value);
    afterDraftChange();
  });
  control.append(input);
  return control;
}

function renderSecretControl(pointer, value, meta = {}) {
  const control = document.createElement("div");
  control.className = "control secret-control";
  const label = document.createElement("label");
  label.textContent = meta.label ?? decodePointer(pointer).slice(-1)[0] ?? pointer;
  control.append(label);

  const row = document.createElement("div");
  row.className = "secret-row";
  const status = document.createElement("span");
  status.className = "admin-badge";
  status.dataset.tone = value === null || value === undefined ? undefined : "ok";
  status.textContent = value === null || value === undefined ? "unset" : "set";
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "replace secret";
  input.autocomplete = "new-password";
  const replace = document.createElement("button");
  replace.type = "button";
  replace.className = "btn btn-ghost";
  replace.textContent = "REPLACE";
  replace.addEventListener("click", () => {
    if (!input.value) return;
    setByPointer(state.draft, pointer, input.value);
    afterDraftChange();
    render();
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn btn-ghost";
  clear.textContent = "CLEAR";
  clear.addEventListener("click", () => {
    setByPointer(state.draft, pointer, null);
    afterDraftChange();
    render();
  });
  row.append(status, input, replace, clear);
  control.append(row);
  return control;
}

function renderRawEditor(pointer, label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "control raw-editor";
  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  const textarea = document.createElement("textarea");
  textarea.spellcheck = false;
  textarea.value = formatJson(value ?? {});
  textarea.addEventListener("input", () => {
    try {
      const parsed = JSON.parse(textarea.value);
      if (pointer === "/" && (!isObject(parsed) || Array.isArray(parsed))) throw new Error("Root must be an object.");
      setByPointer(state.draft, pointer, parsed);
      textarea.removeAttribute("aria-invalid");
      afterDraftChange(false);
    } catch {
      textarea.setAttribute("aria-invalid", "true");
    }
  });
  wrapper.append(labelEl, textarea);
  return wrapper;
}

function afterDraftChange() {
  computeDirty();
  renderBadges();
}

function renderPresets() {
  const presets = state.snapshot?.metadata?.presets ?? [];
  els.presetPanel.replaceChildren();
  if (presets.length === 0) return;
  for (const preset of presets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost";
    button.title = preset.description;
    button.textContent = preset.label;
    button.addEventListener("click", () => applyPatch(preset.patch));
    els.presetPanel.append(button);
  }
}

function applyPatch(patch) {
  for (const op of patch) {
    if (op.op === "delete") deleteByPointer(state.draft, op.path);
    else setByPointer(state.draft, op.path, clone(op.value));
  }
  afterDraftChange();
  render();
  showAlert("Preset staged. Review the diff before saving.", "ok");
}

function renderValidation() {
  const validation = state.validation ?? state.snapshot?.validation;
  els.validationSummary.textContent = validation?.ok ? "No blocking validation errors." : "Validation needs attention.";
  els.validationList.replaceChildren();
  for (const message of validation?.messages ?? []) {
    const item = document.createElement("div");
    item.className = "validation-item";
    item.dataset.severity = message.severity;
    item.innerHTML = `<strong>${escapeHtml(message.path)}</strong><p>${escapeHtml(message.message)}</p><span class="muted">${escapeHtml(message.code)}</span>`;
    els.validationList.append(item);
  }
}

function renderBackups() {
  els.backupList.replaceChildren();
  for (const backup of state.snapshot?.backups ?? []) {
    const item = document.createElement("div");
    item.className = "compact-item";
    item.innerHTML = `<strong>${escapeHtml(backup.id)}</strong><span>${escapeHtml(shortHash(backup.hash))}</span>`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost";
    button.textContent = "ROLLBACK";
    button.addEventListener("click", () => rollbackBackup(backup.id));
    item.append(button);
    els.backupList.append(item);
  }
  if (!els.backupList.children.length) els.backupList.innerHTML = `<div class="compact-item">No backups yet.</div>`;
}

function renderProfiles() {
  els.profileList.replaceChildren();
  for (const profile of state.snapshot?.profiles ?? []) {
    const item = document.createElement("div");
    item.className = "compact-item";
    item.innerHTML = `<strong>${escapeHtml(profile.name)}</strong><span>${profile.patchCount} operations</span>`;
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "btn btn-ghost";
    preview.textContent = "PREVIEW";
    preview.addEventListener("click", () => previewProfile(profile.id));
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "btn btn-ghost";
    apply.textContent = "APPLY";
    apply.addEventListener("click", () => applyProfile(profile.id));
    item.append(preview, apply);
    els.profileList.append(item);
  }
  if (!els.profileList.children.length) els.profileList.innerHTML = `<div class="compact-item">No profiles saved.</div>`;
}

function renderDiff(diff = state.dirty, impact = null) {
  els.diffList.replaceChildren();
  els.diffImpact.replaceChildren();
  const impactSet = new Set(impact ?? diff.flatMap((entry) => entry.impact ?? entry.meta?.impact ?? []));
  for (const item of impactSet) els.diffImpact.append(badge(impactLabel(item), item === "appliesImmediately" ? "ok" : undefined));
  const hasHighRisk = diff.some((entry) => entry.highRisk || entry.meta?.highRisk || entry.meta?.pathLike || entry.meta?.commandLike || entry.meta?.secret);
  if (hasHighRisk) els.diffImpact.append(badge("high risk", "warn"));
  els.highRiskConfirm.closest(".confirm-row").hidden = !hasHighRisk;
  els.highRiskConfirm.checked = false;

  if (diff.length === 0) {
    els.diffList.innerHTML = `<div class="diff-item">No pending changes.</div>`;
    return;
  }

  for (const entry of diff) {
    const item = document.createElement("div");
    item.className = "diff-item";
    const risk = entry.highRisk || entry.meta?.highRisk || entry.meta?.pathLike || entry.meta?.commandLike || entry.meta?.secret;
    item.innerHTML = `<code>${escapeHtml(entry.path)}</code> <span class="admin-badge" data-tone="${risk ? "warn" : ""}">${escapeHtml(entry.kind)}</span>
      <div class="diff-values"><pre>${escapeHtml(formatJson(entry.before))}</pre><pre>${escapeHtml(formatJson(entry.after))}</pre></div>`;
    els.diffList.append(item);
  }
}

async function validateDraft(showModal = false) {
  const { payload } = await api("/api/config/validate", { method: "POST", body: { draft: state.draft } });
  state.validation = payload.validation ?? { ok: false, messages: [{ path: "/", message: payload.message ?? "Validation failed.", severity: "error", code: payload.error ?? "error" }] };
  renderValidation();
  renderBadges();
  if (payload.diff) renderDiff(payload.diff, payload.impact);
  if (showModal) els.diffModal.showModal();
  return payload;
}

async function confirmPendingAction() {
  const action = state.pendingAction ?? { type: "save" };
  const highRiskAccepted = els.highRiskConfirm.closest(".confirm-row").hidden ? false : els.highRiskConfirm.checked;
  if (action.type === "rollback") {
    await rollbackBackup(action.backupId, highRiskAccepted);
    return;
  }
  if (action.type === "profileApply") {
    await applyProfile(action.profileId, highRiskAccepted);
    return;
  }
  await saveDraft();
}

function handleHighRiskResponse(action, payload, message) {
  state.pendingAction = action;
  state.validation = payload.validation;
  renderDiff(payload.diff, payload.impact);
  renderValidation();
  els.confirmSaveBtn.disabled = false;
  els.diffModal.showModal();
  showAlert(message);
}

async function saveDraft() {
  const highRiskAccepted = els.highRiskConfirm.closest(".confirm-row").hidden ? false : els.highRiskConfirm.checked;
  const { status, payload } = await api("/api/config/save", {
    method: "POST",
    body: {
      draft: state.draft,
      expectedHash: state.snapshot.source.hash,
      highRiskAccepted,
    },
  });
  if (status === 409 && payload.error === "high_risk_confirmation_required") {
    handleHighRiskResponse({ type: "save" }, payload, "High-risk changes require explicit confirmation.");
    return;
  }
  if (status === 409 && payload.error === "config_conflict") {
    state.snapshot = payload.current;
    state.draft = clone(payload.current.raw ?? {});
    state.validation = payload.current.validation;
    render();
    showAlert("The config file changed on disk. Reloaded the latest version.");
    return;
  }
  if (status >= 400) {
    state.validation = payload.validation;
    renderValidation();
    showAlert(payload.message ?? payload.error ?? "Save failed.");
    return;
  }
  state.pendingAction = null;
  await loadConfig();
  showAlert(`Config written. Backup: ${payload.backup?.id ?? "created"}.`, "ok");
  if (els.diffModal.open) els.diffModal.close();
}

async function rollbackBackup(backupId, highRiskAccepted = false) {
  const response = await api("/api/config/rollback", {
    method: "POST",
    body: { backupId, expectedHash: state.snapshot.source.hash, highRiskAccepted },
  });
  if (response.status === 409 && response.payload.error === "high_risk_confirmation_required") {
    handleHighRiskResponse({ type: "rollback", backupId }, response.payload, "Rollback changes require explicit high-risk confirmation.");
    return;
  }
  if (response.status >= 400) {
    showAlert(response.payload.message ?? response.payload.error ?? "Rollback failed.");
    return;
  }
  state.pendingAction = null;
  await loadConfig();
  showAlert("Rollback applied through the normal backup and validation flow.", "ok");
  if (els.diffModal.open) els.diffModal.close();
}

async function createProfile(event) {
  event.preventDefault();
  const name = els.profileName.value.trim();
  if (!name) return;
  const patch = state.dirty
    .filter((entry) => !metadataFor(entry.path)?.secret)
    .map((entry) => entry.after === undefined ? { op: "delete", path: entry.path } : { op: "set", path: entry.path, value: entry.after });
  if (patch.length === 0) {
    showAlert("No non-secret pending changes to save as a profile.");
    return;
  }
  const response = await api("/api/config/profiles", {
    method: "POST",
    body: { name, patch, includesSecrets: false },
  });
  if (response.status >= 400) {
    showAlert(response.payload.message ?? response.payload.error ?? "Profile save failed.");
    return;
  }
  els.profileName.value = "";
  await loadConfig(false);
  showAlert("Profile saved without secret values.", "ok");
}

async function previewProfile(profileId) {
  const response = await api(`/api/config/profiles/${encodeURIComponent(profileId)}/preview`, { method: "POST", body: {} });
  if (response.status >= 400) {
    showAlert(response.payload.message ?? response.payload.error ?? "Profile preview failed.");
    return;
  }
  state.pendingAction = null;
  els.confirmSaveBtn.disabled = true;
  state.validation = response.payload.validation;
  renderValidation();
  renderDiff(response.payload.diff, response.payload.impact);
  els.diffModal.showModal();
}

async function applyProfile(profileId, highRiskAccepted = false) {
  const response = await api(`/api/config/profiles/${encodeURIComponent(profileId)}/apply`, {
    method: "POST",
    body: { expectedHash: state.snapshot.source.hash, highRiskAccepted },
  });
  if (response.status === 409 && response.payload.error === "high_risk_confirmation_required") {
    handleHighRiskResponse({ type: "profileApply", profileId }, response.payload, "Profile changes require explicit high-risk confirmation.");
    return;
  }
  if (response.status >= 400) {
    showAlert(response.payload.message ?? response.payload.error ?? "Profile apply failed.");
    return;
  }
  state.pendingAction = null;
  await loadConfig();
  showAlert("Profile applied through the normal save path.", "ok");
  if (els.diffModal.open) els.diffModal.close();
}

async function loadConfig(restoreSection = true) {
  const previous = restoreSection ? state.currentSection : null;
  const { payload, status } = await api("/api/config");
  if (status >= 400) throw new Error(payload.message ?? payload.error ?? "Failed to load config.");
  state.snapshot = payload;
  state.draft = clone(payload.raw ?? {});
  state.validation = payload.validation;
  state.currentSection = previous ?? payload.metadata?.sections?.[0]?.id ?? "repos";
  render();
}

function render() {
  if (!state.snapshot) return;
  els.sourcePath.textContent = state.snapshot.source.path;
  els.sourceHash.textContent = `${shortHash(state.snapshot.source.hash)} / ${Math.round((state.snapshot.source.sizeBytes ?? 0) / 1024)} KB`;
  renderSections();
  renderPresets();
  computeDirty();
  renderBadges();
  renderSection();
  renderValidation();
  renderBackups();
  renderProfiles();
}

function bindDom() {
  for (const id of [
    "alerts", "backupList", "closeDiffBtn", "confirmSaveBtn", "diffImpact", "diffList", "diffModal",
    "highRiskConfirm", "presetPanel", "profileForm", "profileList", "profileName", "reloadBtn",
    "saveBtn", "sectionBody", "sectionDescription", "sectionEyebrow", "sectionNav", "sectionTitle",
    "sourceHash", "sourcePath", "statusBadges", "tokenInput", "validateBtn", "validationList", "validationSummary",
  ]) {
    els[id] = document.getElementById(id);
  }

  els.tokenInput.value = state.token;
  els.tokenInput.addEventListener("change", () => {
    state.token = els.tokenInput.value.trim();
    if (state.token) sessionStorage.setItem("sdlConfigToken", state.token);
    else sessionStorage.removeItem("sdlConfigToken");
    loadConfig().catch((error) => showAlert(error instanceof Error ? error.message : String(error)));
  });
  els.reloadBtn.addEventListener("click", () => loadConfig());
  els.validateBtn.addEventListener("click", () => {
    state.pendingAction = null;
    els.confirmSaveBtn.disabled = true;
    validateDraft(true);
  });
  els.saveBtn.addEventListener("click", async () => {
    state.pendingAction = { type: "save" };
    els.confirmSaveBtn.disabled = false;
    await validateDraft(false);
    renderDiff();
    els.diffModal.showModal();
  });
  els.confirmSaveBtn.addEventListener("click", confirmPendingAction);
  els.closeDiffBtn.addEventListener("click", () => els.diffModal.close());
  els.profileForm.addEventListener("submit", createProfile);
}

bindDom();
loadConfig().catch((error) => {
  showAlert(error instanceof Error ? error.message : String(error));
});
