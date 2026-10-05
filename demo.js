// Invoice-to-draft-bill demo. Runs entirely in the browser: rule-based parsing,
// validation checks, an approval queue, and a QuickBooks Online bill-import CSV.
(() => {
  "use strict";

  // Invented sample documents (vendors and amounts are not real).
  const SAMPLES = [
    {
      id: "ridgeline",
      label: "Ridgeline Freight Co.",
      note: "Freight invoice, Net 30",
      text: `Ridgeline Freight Co.
2210 Industrial Pkwy, Columbus, OH 43219
INVOICE
Invoice No: INV-20931
Invoice Date: Sep 28, 2026
Terms: Net 30
PO Number: PO-4471
Bill To: Your Company

Description Qty Unit Price Amount
LTL freight Columbus OH to Dayton OH 1 $412.50 $412.50
Liftgate delivery 1 $65.00 $65.00
Fuel surcharge 1 $49.13 $49.13

Subtotal $526.63
Tax $0.00
Total Due $526.63`,
    },
    {
      id: "calder",
      label: "Calder Paper & Packaging",
      note: "Supplies with sales tax",
      text: `Calder Paper & Packaging
48 Mill Road, Erie, PA 16501
Invoice Number: 77812
Invoice Date: 09/29/2026
Terms: Net 15
PO: PO-4468

Item Qty Price Amount
Corrugated boxes 18x12x12 bundle of 25 40 18.75 750.00
Packing tape 48mm 36 3.20 115.20
Stretch film 18in 6 24.90 149.40

Subtotal 1,014.60
Sales Tax 7.25% 73.56
Total Due 1,088.16`,
    },
    {
      id: "northfork",
      label: "Northfork Electrical Supply",
      note: "Has a math error",
      text: `Northfork Electrical Supply
915 Commerce St, Fort Wayne, IN 46802
Invoice # NES-5520
Invoice Date: Oct 2, 2026
Due Date: Oct 17, 2026

Description Qty Unit Price Amount
LED panel 2x4 12 64.00 768.00
Wire 12/2 250ft 3 118.40 355.20
Breaker 20A 10 11.95 119.50

Subtotal 1,252.70
Tax 0.00
Total 1,252.70`,
    },
    {
      id: "ridgeline-again",
      label: "Ridgeline Freight Co. (resent)",
      note: "Same invoice emailed twice",
      text: `Ridgeline Freight Co.
2210 Industrial Pkwy, Columbus, OH 43219
INVOICE - PAYMENT REMINDER
Invoice No: INV-20931
Invoice Date: Sep 28, 2026
Terms: Net 30
PO Number: PO-4471

Description Qty Unit Price Amount
LTL freight Columbus OH to Dayton OH 1 $412.50 $412.50
Liftgate delivery 1 $65.00 $65.00
Fuel surcharge 1 $49.13 $49.13

Subtotal $526.63
Tax $0.00
Total Due $526.63`,
    },
  ];

  // Keyword hints for a suggested expense account (QuickBooks default chart names).
  const ACCOUNTS = [
    [/freight|shipping|delivery|ltl|liftgate|fuel surcharge/i, "Freight and delivery"],
    [/box|tape|film|paper|packag|label/i, "Supplies"],
    [/led|wire|breaker|electrical|panel/i, "Repairs and maintenance"],
    [/software|subscription|license/i, "Software"],
  ];

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const DATE_RE = String.raw`([A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})`;
  const MONEY = String.raw`\$?\s?(-?[\d,]+\.\d{2})`;

  const queue = [];
  const $ = (id) => document.getElementById(id);
  const money = (n) => (n == null || isNaN(n) ? "?" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const num = (s) => (s == null ? null : parseFloat(String(s).replace(/,/g, "")));
  const round2 = (n) => Math.round(n * 100) / 100;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function parseDate(s) {
    if (!s) return null;
    let m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/);
    if (m) {
      const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith("sept") ? 4 : 3)];
      return mo == null ? null : new Date(+m[3], mo, +m[2]);
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) return new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return null;
  }
  const fmtDate = (d) => (d ? `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}` : "");

  function find(text, re) {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  }

  function parseInvoice(text) {
    const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const vendor = rows.find((l) => !/^invoice\b/i.test(l)) || null;

    const invoiceNo = find(text, /invoice\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]*)/i);
    const invoiceDateRaw = find(text, new RegExp(String.raw`invoice\s*date\s*:?\s*` + DATE_RE, "i")) || find(text, new RegExp(String.raw`\bdate\s*:?\s*` + DATE_RE, "i"));
    const dueDateRaw = find(text, new RegExp(String.raw`due\s*date\s*:?\s*` + DATE_RE, "i"));
    const terms = find(text, /terms\s*:?\s*(net\s*\d+|due on receipt)/i);
    const po = find(text, /\bP\.?O\.?\s*(?:no\.?|number|#)?\s*:?\s*((?:PO-)?[A-Z0-9-]*\d[A-Z0-9-]*)/i);

    const subtotal = num(find(text, new RegExp(String.raw`subtotal\s*:?\s*` + MONEY, "i")));
    const tax = num(find(text, new RegExp(String.raw`(?:sales\s*)?tax(?:\s*[\d.]+%)?\s*:?\s*` + MONEY, "i")));
    let total = null;
    for (const m of text.matchAll(new RegExp(String.raw`(?<!sub)(?:total\s*due|amount\s*due|balance\s*due|total)\s*:?\s*(?:USD\s*)?` + MONEY, "gi"))) total = num(m[1]);

    const lines = [];
    const lineRe = new RegExp(String.raw`^(.+?)\s+(\d+(?:\.\d+)?)\s+` + MONEY + String.raw`\s+` + MONEY + "$");
    for (const l of rows) {
      if (/subtotal|total|tax|balance|amount due/i.test(l)) continue;
      const m = l.match(lineRe);
      if (m) lines.push({ desc: m[1], qty: +m[2], unit: num(m[3]), amount: num(m[4]) });
    }

    const invoiceDate = parseDate(invoiceDateRaw);
    let dueDate = parseDate(dueDateRaw);
    if (!dueDate && invoiceDate && terms && /net\s*(\d+)/i.test(terms)) {
      dueDate = new Date(invoiceDate.getTime() + parseInt(terms.match(/\d+/)[0], 10) * 86400000);
    }

    const blob = lines.map((l) => l.desc).join(" ") + " " + (vendor || "");
    const account = (ACCOUNTS.find(([re]) => re.test(blob)) || [null, "Uncategorized expense"])[1];

    return { vendor, invoiceNo, invoiceDate, dueDate, terms, po, subtotal, tax, total, lines, account, raw: text };
  }

  function validate(inv) {
    const checks = [];
    const add = (ok, msg) => checks.push({ ok, msg });
    add(!!inv.vendor, inv.vendor ? "Vendor found" : "Vendor name not found");
    add(!!inv.invoiceNo, inv.invoiceNo ? "Invoice number found" : "Invoice number not found");
    add(!!inv.invoiceDate, inv.invoiceDate ? "Invoice date found" : "Invoice date not found");
    add(!!inv.dueDate, inv.dueDate ? (inv.terms && !/due\s*date/i.test(inv.raw) ? `Due date worked out from terms (${inv.terms})` : "Due date found") : "Due date and terms not found");
    add(inv.lines.length > 0, inv.lines.length ? `${inv.lines.length} line items read` : "No line items read");

    const badLine = inv.lines.find((l) => Math.abs(round2(l.qty * l.unit) - l.amount) > 0.01);
    if (inv.lines.length) add(!badLine, badLine ? `Line "${badLine.desc}": ${l2(badLine)}` : "Every line: qty x price = amount");

    const lineSum = round2(inv.lines.reduce((s, l) => s + l.amount, 0));
    if (inv.subtotal != null && inv.lines.length) {
      const ok = Math.abs(lineSum - inv.subtotal) <= 0.01;
      add(ok, ok ? "Lines add up to the subtotal" : `Lines add up to ${money(lineSum)} but the subtotal says ${money(inv.subtotal)} (difference ${money(round2(inv.subtotal - lineSum))})`);
    }
    if (inv.total != null) {
      const base = inv.subtotal != null ? inv.subtotal : lineSum;
      const ok = Math.abs(round2(base + (inv.tax || 0)) - inv.total) <= 0.01;
      add(ok, ok ? "Subtotal plus tax equals the total" : `Subtotal plus tax is ${money(round2(base + (inv.tax || 0)))} but the total says ${money(inv.total)}`);
    } else add(false, "Total not found");

    const dup = queue.find((q) => q.inv.invoiceNo && q.inv.invoiceNo === inv.invoiceNo && q.inv.vendor === inv.vendor);
    add(!dup, dup ? `Possible duplicate: ${inv.vendor} ${inv.invoiceNo} is already in the queue` : "Not a duplicate");
    return checks;
  }
  function l2(l) {
    return `${l.qty} x ${money(l.unit)} is ${money(round2(l.qty * l.unit))}, invoice says ${money(l.amount)}`;
  }

  function renderExtract(inv, checks, source) {
    const field = (label, val, ok = true) => `<div class="field"><label>${label}</label><div class="${ok ? "" : "low"}">${esc(val || "not found")}</div></div>`;
    $("extractView").className = "";
    $("extractView").innerHTML = `
      <div class="fields">
        ${field("Vendor", inv.vendor, !!inv.vendor)}
        ${field("Invoice number", inv.invoiceNo, !!inv.invoiceNo)}
        ${field("Invoice date", fmtDate(inv.invoiceDate), !!inv.invoiceDate)}
        ${field("Due date", fmtDate(inv.dueDate), !!inv.dueDate)}
        ${field("PO", inv.po || "none")}
        ${field("Suggested account", inv.account)}
        ${field("Total", money(inv.total), inv.total != null)}
      </div>
      ${inv.lines.length ? `<table class="lines"><thead><tr><th>Line</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>${inv.lines.map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${l.qty}</td><td class="num">${money(l.unit)}</td><td class="num">${money(l.amount)}</td></tr>`).join("")}</tbody></table>` : ""}
      <ul class="checks">${checks.map((c) => `<li class="${c.ok ? "" : "bad"}">${c.ok ? "Pass" : "Check"}: ${esc(c.msg)}</li>`).join("")}</ul>
      <details class="raw"><summary>Show the text that was read (${esc(source)})</summary><pre>${esc(inv.raw)}</pre></details>`;
  }

  function addToQueue(inv, checks) {
    const issues = checks.filter((c) => !c.ok).map((c) => c.msg);
    queue.push({ inv, issues, status: issues.length ? "review" : "ready" });
    renderQueue();
  }

  function renderQueue() {
    if (!queue.length) return;
    const label = { ready: "Ready to approve", review: "Needs review", approved: "Approved", rejected: "Rejected" };
    $("queueView").className = "";
    $("queueView").innerHTML = `<table class="qtable"><thead><tr><th>Vendor</th><th class="hide-sm">Invoice</th><th class="hide-sm">Due</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>${queue
      .map(
        (q, i) => `<tr>
          <td>${esc(q.inv.vendor)}${q.issues.length && q.status === "review" ? `<div class="hint">${esc(q.issues[0])}</div>` : ""}</td>
          <td class="hide-sm">${esc(q.inv.invoiceNo)}</td>
          <td class="hide-sm">${fmtDate(q.inv.dueDate)}</td>
          <td class="num">${money(q.inv.total)}</td>
          <td><span class="tag ${q.status === "review" ? "review" : q.status === "ready" ? "" : "done"}">${label[q.status]}</span></td>
          <td>${q.status === "ready" || q.status === "review" ? `<button class="mini" data-act="approve" data-i="${i}">Approve</button> <button class="mini" data-act="reject" data-i="${i}">Reject</button>` : ""}</td>
        </tr>`
      )
      .join("")}</tbody></table>`;
    $("exportBtn").disabled = !queue.some((q) => q.status === "approved");
  }

  function exportCsv() {
    const header = ["Bill No", "Supplier", "Bill Date", "Due Date", "Terms", "Memo", "Account", "Line Description", "Line Amount"];
    const rows = [header];
    for (const q of queue.filter((x) => x.status === "approved")) {
      const i = q.inv;
      const items = i.lines.length ? i.lines.map((l) => [l.desc, l.amount.toFixed(2)]) : [["Invoice total", (i.total || 0).toFixed(2)]];
      if (i.tax) items.push(["Sales tax", i.tax.toFixed(2)]);
      for (const [d, a] of items) rows.push([i.invoiceNo, i.vendor, fmtDate(i.invoiceDate), fmtDate(i.dueDate), i.terms || "", i.po || "", i.account, d, a]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "approved-bills-quickbooks.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function process(text, source) {
    const inv = parseInvoice(text);
    const checks = validate(inv);
    renderExtract(inv, checks, source);
    addToQueue(inv, checks);
  }

  // Rebuild reading-order lines from pdf.js text items by grouping on y position.
  async function pdfToText(file) {
    if (!window.pdfjsLib) throw new Error("PDF reader did not load. Check your connection and try again.");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let p = 1; p <= Math.min(pdf.numPages, 5); p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      const byY = new Map();
      for (const it of content.items) {
        if (!it.str.trim()) continue;
        const y = Math.round(it.transform[5] / 3) * 3;
        if (!byY.has(y)) byY.set(y, []);
        byY.get(y).push({ x: it.transform[4], s: it.str.trim() });
      }
      [...byY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => out.push(items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ")));
    }
    return out.join("\n");
  }

  function init() {
    const list = $("sampleList");
    list.innerHTML = SAMPLES.map((s) => `<button class="sample" type="button" data-id="${s.id}" aria-pressed="false"><b>${esc(s.label)}</b><span>${esc(s.note)}</span></button>`).join("");
    list.addEventListener("click", (e) => {
      const btn = e.target.closest(".sample");
      if (!btn) return;
      list.querySelectorAll(".sample").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      const s = SAMPLES.find((x) => x.id === btn.dataset.id);
      process(s.text, "sample");
    });
    $("pdfInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $("pdfStatus").textContent = "Reading the PDF in your browser...";
      try {
        const text = await pdfToText(file);
        if (text.replace(/\s/g, "").length < 20) throw new Error("No text found. This looks like a scanned image; a real build adds OCR for those.");
        process(text, file.name);
        $("pdfStatus").textContent = `Read ${file.name}. Nothing was uploaded.`;
      } catch (err) {
        $("pdfStatus").textContent = err.message;
      }
      e.target.value = "";
    });
    $("queueView").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      queue[+b.dataset.i].status = b.dataset.act === "approve" ? "approved" : "rejected";
      renderQueue();
    });
    $("exportBtn").addEventListener("click", exportCsv);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
