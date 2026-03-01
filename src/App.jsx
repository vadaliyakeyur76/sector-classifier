import { useState, useRef, useCallback, useEffect } from "react";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";

const SECTOR_PALETTE = [
  "#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4",
  "#f97316", "#6366f1", "#14b8a6", "#a855f7", "#84cc16", "#d946ef", "#0ea5e9",
  "#e11d48", "#22c55e", "#78716c", "#fb923c", "#64748b", "#facc15",
];
const getColor = (i) => SECTOR_PALETTE[i % SECTOR_PALETTE.length];

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keySet, setKeySet] = useState(false);
  const [model, setModel] = useState("gemini-2.5-flash");
  const [companies, setCompanies] = useState([]);
  const [analyzed, setAnalyzed] = useState([]);
  const [sectorMap, setSectorMap] = useState({});
  const [processing, setProcessing] = useState(false);
  const [resolvingIsins, setResolvingIsins] = useState(false);
  const [isIsinUpload, setIsIsinUpload] = useState(false);
  const [currentCompany, setCurrentCompany] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [selectedSector, setSelectedSector] = useState("__all__");
  const [searchTerm, setSearchTerm] = useState("");
  const [logs, setLogs] = useState([]);
  const [expandedRow, setExpandedRow] = useState(null);
  const [batchSize, setBatchSize] = useState(5);
  const fileRef = useRef(null);
  const abortRef = useRef(false);
  const logsEndRef = useRef(null);

  const addLog = useCallback((msg) => {
    setLogs((p) => [...p.slice(-200), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    const map = {};
    analyzed.forEach((item) => {
      // Group by Main Industry or Unclassified if not present
      let mi = item.mainIndustry || "Unclassified";
      if (!map[mi]) map[mi] = [];
      map[mi].push(item);
    });
    const sorted = Object.entries(map).sort((a, b) => b[1].length - a[1].length);
    const sortedMap = {};
    sorted.forEach(([k, v]) => { sortedMap[k] = v; });
    setSectorMap(sortedMap);
  }, [analyzed]);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setError("");
    setAnalyzed([]);
    setLogs([]);

    const ext = file.name.split(".").pop().toLowerCase();

    const processData = (data, cols) => {
      // Find ISIN first
      const isinCol = cols.find((c) => /isin/i.test(c));
      const nameCol = cols.find((c) => /company|name|stock|ticker|symbol|scrip|entity/i.test(c)) || cols[0];

      let extracted = [];
      let isIsin = false;

      if (isinCol) {
        extracted = data.map((row) => (row[isinCol] || "").toString().trim()).filter(Boolean);
        isIsin = true;
      } else {
        extracted = data.map((row) => (row[nameCol] || "").toString().trim()).filter(Boolean);
        isIsin = false;
      }

      setCompanies([...new Set(extracted)]);
      setIsIsinUpload(isIsin);
      addLog(`Loaded ${extracted.length} items from "${isIsin ? isinCol : nameCol}" column`);
    };

    if (ext === "csv" || ext === "tsv") {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => processData(res.data, res.meta.fields || []),
        error: () => setError("Failed to parse CSV."),
      });
    } else if (/xlsx?|xlsm/.test(ext)) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const wb = XLSX.read(ev.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
          if (!data.length) { setError("Empty spreadsheet."); return; }
          processData(data, Object.keys(data[0]));
        } catch { setError("Failed to parse Excel."); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setError("Upload .csv, .tsv, .xlsx, or .xls files only.");
    }
  };

  const resolveIsinsToNames = async (batch) => {
    const prompt = `You are a financial data expert. Convert the following list of ISIN (International Securities Identification Number) codes into their corresponding official Company Names.
    
ISINs:
${batch.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Respond ONLY with a JSON array. No markdown, no extra text.
[{"isin":"INE...","companyName":"Name"}...]\n`;

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        }),
      }
    );

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const msg = errBody?.error?.message || `HTTP ${resp.status}`;
      if (resp.status === 429) throw new Error("RATE_LIMIT:" + msg);
      throw new Error(msg);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = text.replace(/```json|```/g, "").trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
      throw new Error("JSON_PARSE_FAIL");
    }
  };

  const analyzeCompanies = async (batch) => {
    const prompt = `You are a deep equity research analyst. For EACH company below, do the following:

1. Identify the company's KEY PRODUCTS and SERVICES.
2. Determine the END-USE APPLICATIONS or customers for those products (e.g., military radar systems, cloud server infrastructure, consumer smartphones, power generation, hospital equipment, etc.).
3. Based on the end-use, classify the company into an END-USER INDUSTRY (Sub-Industry).
4. Classify that Sub-Industry under a broader MAIN INDUSTRY.

CLASSIFICATION RULES:
- Classify based on PRODUCT END-USE, not just what they make or how they make it.
- A company making connectors used in fighter jets -> Sub-Industry: "Defence Electronics", Main Industry: "Defence & Aerospace"
- A company making cooling systems for server farms -> Sub-Industry: "Data Centre Infrastructure", Main Industry: "IT & Technology"
- A company making specialty chemicals for chip fabrication -> Sub-Industry: "Semiconductor Materials", Main Industry: "Specialty Chemicals"
- Be specific with the Sub-Industry, but categorize them into standard, readable Main Industries.
- If unknown or highly diversified, use "Diversified" or "Unclassified" for both.

Companies:
${batch.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Respond ONLY with a JSON array. No markdown, no backticks, no extra text.
[{"company":"Name","product":"key products/services","endUse":"where product is consumed/applied","subIndustry":"end-user industry","mainIndustry":"broader industry category"}]`;

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.15, maxOutputTokens: 8192 },
        }),
      }
    );

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const msg = errBody?.error?.message || `HTTP ${resp.status}`;
      if (resp.status === 429) throw new Error("RATE_LIMIT:" + msg);
      throw new Error(msg);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = text.replace(/```json|```/g, "").trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
      throw new Error("JSON_PARSE_FAIL");
    }
  };

  const startAnalysis = async () => {
    if (!apiKey) { setError("Enter your Gemini API key first."); return; }
    if (!companies.length) { setError("Upload a file with companies or ISINs."); return; }

    setProcessing(true);
    setError("");
    setAnalyzed([]);
    abortRef.current = false;

    const totalStr = companies.length;
    let actualCompaniesToAnalyze = companies; // Strings: either ISINs or Names
    let isinMapping = {}; // maps name -> ISIN for later

    // --- PHASE 1: Resolve ISINs (If necessary) ---
    if (isIsinUpload) {
      setResolvingIsins(true);
      setProgress({ done: 0, total: totalStr });
      addLog(`Phase 1: Resolving ${totalStr} ISINs to Company Names`);

      let mappedNames = [];
      let i = 0;
      while (i < totalStr && !abortRef.current) {
        const batch = companies.slice(i, i + batchSize * 2); // Can batch larger for simple ISIN lookups
        const batchNum = Math.floor(i / (batchSize * 2)) + 1;
        const totalBatches = Math.ceil(totalStr / (batchSize * 2));

        setCurrentCompany(batch.join(", "));
        addLog(`[${batchNum}/${totalBatches}] Resolving ISINs: ${batch.join(", ")}`);

        try {
          const results = await resolveIsinsToNames(batch);
          results.forEach(r => {
            if (r.companyName && r.isin) {
              mappedNames.push(r.companyName);
              isinMapping[r.companyName] = r.isin;
            }
          });
          setProgress({ done: mappedNames.length, total: totalStr });
          i += batchSize * 2;
          if (i < totalStr) await sleep(1000);
        } catch (err) {
          if (err.message.startsWith("RATE_LIMIT")) {
            addLog(`Rate limited. Waiting 30s...`);
            await sleep(30000);
          } else {
            addLog(`Error resolving ISINs: ${err.message}. Retrying...`);
            await sleep(3000);
          }
        }
      }
      actualCompaniesToAnalyze = mappedNames;
      setResolvingIsins(false);
      addLog(`Phase 1 Complete. Resolved ${mappedNames.length} names.`);
      if (abortRef.current) { setProcessing(false); return; }
    }


    // --- PHASE 2: Core Classification ---
    const total = actualCompaniesToAnalyze.length;
    setProgress({ done: 0, total });
    addLog(`Phase 2: Deep analysis of ${total} companies, batch size ${batchSize}`);

    let allResults = [];
    let i = 0;

    while (i < total && !abortRef.current) {
      const batch = actualCompaniesToAnalyze.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(total / batchSize);

      setCurrentCompany(batch.join(", "));
      addLog(`[${batchNum}/${totalBatches}] Analyzing: ${batch.join(", ")}`);

      try {
        const results = await analyzeCompanies(batch);
        // Inject ISIN back into result mapping if it exists
        const enrichedResults = results.map(r => ({
          ...r,
          isin: isinMapping[r.company] || "-"
        }));

        allResults = [...allResults, ...enrichedResults];
        setAnalyzed([...allResults]);
        setProgress({ done: allResults.length, total });
        addLog(`Done batch ${batchNum}`);
        i += batchSize;
        if (i < total) await sleep(1200);
      } catch (err) {
        if (err.message.startsWith("RATE_LIMIT")) {
          addLog(`Rate limited. Waiting 30s...`);
          await sleep(30000);
        } else if (err.message === "JSON_PARSE_FAIL") {
          addLog(`Parse error. Trying individually...`);
          for (const comp of batch) {
            if (abortRef.current) break;
            try {
              await sleep(1000);
              const res = await analyzeCompanies([comp]);
              const enRes = res.map(r => ({ ...r, isin: isinMapping[r.company] || "-" }));
              allResults = [...allResults, ...enRes];
            } catch {
              allResults.push({ company: comp, isin: isinMapping[comp] || "-", product: "-", endUse: "-", subIndustry: "-", mainIndustry: "Unclassified" });
            }
            setAnalyzed([...allResults]);
            setProgress({ done: allResults.length, total });
          }
          i += batchSize;
        } else {
          addLog(`Error: ${err.message}. Retrying in 5s...`);
          await sleep(5000);
          try {
            const results = await analyzeCompanies(batch);
            const enrichedResults = results.map(r => ({ ...r, isin: isinMapping[r.company] || "-" }));
            allResults = [...allResults, ...enrichedResults];
            setAnalyzed([...allResults]);
          } catch {
            batch.forEach((c) => {
              allResults.push({ company: c, isin: isinMapping[c] || "-", product: "-", endUse: "-", subIndustry: "-", mainIndustry: "Unclassified" });
            });
            setAnalyzed([...allResults]);
          }
          setProgress({ done: allResults.length, total });
          i += batchSize;
        }
      }
    }

    setProcessing(false);
    setCurrentCompany("");
    addLog(`Complete! ${allResults.length} companies analyzed.`);
  };

  const stopAnalysis = () => { abortRef.current = true; };

  const exportExcel = () => {
    if (!Object.keys(sectorMap).length) return;
    const wb = XLSX.utils.book_new();

    const masterData = analyzed.map((item, idx) => ({
      "Sr No": idx + 1,
      "ISIN": item.isin || "-",
      "Company": item.company,
      "Product": item.product || item.products,
      "End Use": item.endUse || item.applications,
      "Sub-Industry": item.subIndustry,
      "Main Industry": item.mainIndustry,
    }));
    const ms = XLSX.utils.json_to_sheet(masterData);
    ms["!cols"] = [{ wch: 6 }, { wch: 15 }, { wch: 28 }, { wch: 42 }, { wch: 42 }, { wch: 30 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ms, "All Companies");

    const sumData = Object.entries(sectorMap).map(([s, c]) => ({
      "Main Industry": s, "Count": c.length,
      "Companies": c.map((x) => x.company).join(", "),
    }));
    const ss = XLSX.utils.json_to_sheet(sumData);
    ss["!cols"] = [{ wch: 30 }, { wch: 8 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ss, "Industry Summary");

    Object.entries(sectorMap).forEach(([sector, comps]) => {
      const name = sector.replace(/[\\/*?[\]:]/g, "").substring(0, 28);
      const sd = comps.map((item, idx) => ({
        "Sr No": idx + 1,
        "ISIN": item.isin || "-",
        "Company": item.company,
        "Product": item.product || item.products,
        "End Use": item.endUse || item.applications,
        "Sub-Industry": item.subIndustry,
      }));
      const ws = XLSX.utils.json_to_sheet(sd);
      ws["!cols"] = [{ wch: 6 }, { wch: 15 }, { wch: 28 }, { wch: 42 }, { wch: 42 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, ws, name);
    });

    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Sector_Classification.xlsx";
    a.click();
  };

  const sectorNames = Object.keys(sectorMap);
  const displayCompanies = selectedSector === "__all__" ? analyzed : (sectorMap[selectedSector] || []);
  const filtered = displayCompanies.filter((c) => !searchTerm || c.company.toLowerCase().includes(searchTerm.toLowerCase()));
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  const S = {
    page: { minHeight: "100vh", background: "#07090e", color: "#b8c4d4", fontFamily: "'IBM Plex Mono','SF Mono',monospace" },
    nav: { padding: "12px 22px", borderBottom: "1px solid #141a26", background: "#090c14", display: "flex", alignItems: "center", justifyContent: "space-between" },
    logo: { width: 30, height: 30, borderRadius: 7, background: "linear-gradient(135deg,#2563eb,#7c3aed)", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 900, color: "#fff" },
    card: { background: "#0b0f18", border: "1px solid #161d2b", borderRadius: 12, padding: 28 },
    input: { width: "100%", padding: "10px 12px", background: "#070910", border: "1px solid #1c2536", borderRadius: 6, color: "#dde4ed", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" },
    btn: (active) => ({ padding: "12px 36px", background: active ? "linear-gradient(135deg,#2563eb,#7c3aed)" : "#1a2030", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: active ? "pointer" : "default", fontFamily: "inherit" }),
    label: { fontSize: 10, color: "#4a5974", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 6 },
    tag: (color) => ({ fontSize: 10, padding: "3px 9px", borderRadius: 4, fontWeight: 600, background: color + "15", color, border: `1px solid ${color}30`, whiteSpace: "nowrap", display: "inline-block" }),
  };

  return (
    <div style={S.page}>
      <div style={S.nav}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={S.logo}>&#9670;</div>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#e8ecf2", letterSpacing: -0.5 }}>Sector Classifier</span>
          <span style={{ fontSize: 9, color: "#3b82f6", background: "#2563eb15", padding: "2px 8px", borderRadius: 4 }}>GEMINI</span>
        </div>
        {keySet && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#3d4f68" }}>{model}</span>
            <button onClick={() => { setKeySet(false); setApiKey(""); }}
              style={{ background: "none", border: "1px solid #1c2536", color: "#4a5974", fontSize: 10, padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}>
              Change Key
            </button>
          </div>
        )}
      </div>

      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "20px 22px" }}>

        {!keySet ? (
          <div style={{ ...S.card, maxWidth: 460, margin: "70px auto" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#e8ecf2", marginBottom: 4 }}>Connect Gemini API</div>
            <div style={{ fontSize: 11, color: "#3d4f68", marginBottom: 22, lineHeight: 1.5 }}>
              Get your key from <span style={{ color: "#3b82f6" }}>aistudio.google.com/apikey</span>
            </div>

            <div style={S.label}>API Key</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input type={showKey ? "text" : "password"} placeholder="AIza..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ ...S.input, flex: 1 }} />
              <button onClick={() => setShowKey(!showKey)} style={{ background: "#10141e", border: "1px solid #1c2536", color: "#4a5974", fontSize: 10, padding: "0 12px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>
                {showKey ? "Hide" : "Show"}
              </button>
            </div>

            <div style={{ ...S.label, marginTop: 18 }}>Model</div>
            <select value={model} onChange={(e) => setModel(e.target.value)} style={S.input}>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>

            <div style={{ ...S.label, marginTop: 18 }}>Batch Size (companies per API call)</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[1, 3, 5, 10, 15].map((n) => (
                <button key={n} onClick={() => setBatchSize(n)} style={{
                  flex: 1, padding: "8px 0", borderRadius: 6, fontFamily: "inherit", cursor: "pointer",
                  background: batchSize === n ? "#2563eb" : "#10141e",
                  border: `1px solid ${batchSize === n ? "#3b82f6" : "#1c2536"}`,
                  color: batchSize === n ? "#fff" : "#4a5974", fontSize: 12, fontWeight: 600,
                }}>{n}</button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "#2d3b50", marginTop: 4 }}>1 = most accurate per company | 15 = fastest</div>

            <button onClick={() => { if (apiKey.trim()) setKeySet(true); }} disabled={!apiKey.trim()} style={{ ...S.btn(!!apiKey.trim()), width: "100%", marginTop: 22 }}>
              Continue
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
              <div onClick={() => !processing && fileRef.current?.click()} style={{ ...S.card, cursor: processing ? "default" : "pointer", textAlign: "center", border: "2px dashed #161d2b", transition: "border-color 0.2s" }}
                onMouseEnter={(e) => !processing && (e.currentTarget.style.borderColor = "#2563eb")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#161d2b")}>
                <input ref={fileRef} type="file" accept=".csv,.tsv,.xlsx,.xls,.xlsm" onChange={handleFile} style={{ display: "none" }} />
                <div style={{ fontSize: 26, marginBottom: 4 }}>&#128202;</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#dde4ed" }}>{fileName || "Upload Company List"}</div>
                <div style={{ fontSize: 11, color: "#3d4f68", marginTop: 3 }}>Excel or CSV with company names</div>
                {companies.length > 0 && <div style={{ marginTop: 10, fontSize: 11, color: "#10b981", background: "#10b98110", padding: "4px 14px", borderRadius: 6, display: "inline-block" }}>Loaded {companies.length} companies</div>}
              </div>

              <div style={{ ...S.card, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                {!processing ? (
                  <>
                    <button onClick={startAnalysis} disabled={!companies.length} style={S.btn(!!companies.length)}>Analyze and Classify</button>
                    {companies.length > 0 && <div style={{ fontSize: 10, color: "#2d3b50", marginTop: 8 }}>~{Math.ceil(companies.length / batchSize)} API calls | batch {batchSize}</div>}
                  </>
                ) : (
                  <div style={{ width: "100%" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#7a8ba3", marginBottom: 4 }}>
                      <span>{progress.done}/{progress.total}</span><span>{pct}%</span>
                    </div>
                    <div style={{ width: "100%", height: 7, background: "#141a26", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#2563eb,#7c3aed)", borderRadius: 4, transition: "width 0.4s" }} />
                    </div>
                    <div style={{ fontSize: 10, color: "#3d4f68", marginBottom: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      Analyzing: {currentCompany}
                    </div>
                    <button onClick={stopAnalysis} style={{ width: "100%", padding: "8px 0", background: "#dc2626", border: "none", borderRadius: 6, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Stop</button>
                  </div>
                )}
              </div>
            </div>

            {error && <div style={{ background: "#dc262610", border: "1px solid #dc262625", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#fca5a5", marginBottom: 14 }}>{error}</div>}

            {analyzed.length > 0 && (
              <>
                <div style={{ ...S.card, padding: 18, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#e8ecf2" }}>{sectorNames.length} Main Industries</span>
                      <span style={{ fontSize: 11, color: "#3d4f68", marginLeft: 10 }}>{analyzed.length} companies</span>
                    </div>
                    <button onClick={exportExcel} style={{
                      padding: "8px 18px", background: "#10b981", border: "none", borderRadius: 6,
                      color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                    }}>Export Industry Excel</button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
                    {sectorNames.slice(0, 15).map((s, i) => {
                      const count = sectorMap[s]?.length || 0;
                      const maxC = sectorMap[sectorNames[0]]?.length || 1;
                      return (
                        <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                          onClick={() => setSelectedSector(selectedSector === s ? "__all__" : s)}>
                          <div style={{ width: 140, fontSize: 10, color: selectedSector === s ? getColor(i) : "#5a6b83", textAlign: "right", fontWeight: selectedSector === s ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{s}</div>
                          <div style={{ flex: 1, height: 16, background: "#141a26", borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${(count / maxC) * 100}%`, background: getColor(i), borderRadius: 3, opacity: selectedSector === s ? 1 : 0.6, transition: "all 0.3s", minWidth: 3 }} />
                          </div>
                          <div style={{ width: 30, fontSize: 10, color: "#7a8ba3", fontWeight: 700 }}>{count}</div>
                        </div>
                      );
                    })}
                    {sectorNames.length > 15 && <div style={{ fontSize: 10, color: "#2d3b50", textAlign: "center", marginTop: 4 }}>+{sectorNames.length - 15} more in dropdown</div>}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <select value={selectedSector} onChange={(e) => setSelectedSector(e.target.value)}
                    style={{ ...S.input, width: "auto", minWidth: 240 }}>
                    <option value="__all__">All Industries ({analyzed.length})</option>
                    {sectorNames.map((s) => <option key={s} value={s}>{s} ({sectorMap[s]?.length})</option>)}
                  </select>
                  <input placeholder="Search company..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                    style={{ ...S.input, flex: 1, minWidth: 180 }} />
                  <span style={{ fontSize: 11, color: "#3d4f68", alignSelf: "center" }}>{filtered.length} shown</span>
                </div>

                <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto", maxHeight: 540, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: "#080c14", position: "sticky", top: 0, zIndex: 2 }}>
                          {["#", "ISIN", "Company", "Product", "End Use", "Sub-Industry", "Main Industry"].map((h) => (
                            <th key={h} style={{ padding: "10px 11px", textAlign: "left", color: "#3d4f68", fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.8, borderBottom: "1px solid #141a26" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((item, idx) => {
                          const open = expandedRow === idx;
                          return (
                            <tr key={idx} onClick={() => setExpandedRow(open ? null : idx)}
                              style={{ borderTop: "1px solid #0f1420", background: open ? "#10141e" : idx % 2 === 0 ? "transparent" : "#090c13", cursor: "pointer", transition: "background 0.1s" }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = "#10141e")}
                              onMouseLeave={(e) => (e.currentTarget.style.background = open ? "#10141e" : idx % 2 === 0 ? "transparent" : "#090c13")}>
                              <td style={{ padding: "7px 11px", color: "#2d3b50", fontSize: 10 }}>{idx + 1}</td>
                              <td style={{ padding: "7px 11px", color: "#64748b", fontSize: 10, fontFamily: "monospace" }}>{item.isin || "-"}</td>
                              <td style={{ padding: "7px 11px", color: "#e8ecf2", fontWeight: 600, whiteSpace: "nowrap" }}>{item.company}</td>
                              <td style={{ padding: "7px 11px", color: "#7a8ba3", maxWidth: 220 }}>
                                <div style={{ overflow: open ? "visible" : "hidden", textOverflow: open ? "unset" : "ellipsis", whiteSpace: open ? "normal" : "nowrap" }}>{item.product || item.products}</div>
                              </td>
                              <td style={{ padding: "7px 11px", color: "#7a8ba3", maxWidth: 220 }}>
                                <div style={{ overflow: open ? "visible" : "hidden", textOverflow: open ? "unset" : "ellipsis", whiteSpace: open ? "normal" : "nowrap" }}>{item.endUse || item.applications}</div>
                              </td>
                              <td style={{ padding: "7px 11px" }}>
                                {item.subIndustry ? <span style={S.tag(getColor(14))}>{item.subIndustry}</span> : <span style={{ color: "#5a6b83" }}>-</span>}
                              </td>
                              <td style={{ padding: "7px 11px" }}>
                                {item.mainIndustry ? <span style={S.tag(getColor(1))}>{item.mainIndustry}</span> : <span style={{ color: "#5a6b83" }}>-</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {filtered.length === 0 && <div style={{ padding: 36, textAlign: "center", color: "#2d3b50", fontSize: 12 }}>No matches.</div>}
                  </div>
                </div>
              </>
            )}

            {logs.length > 0 && (
              <div style={{ marginTop: 14, background: "#070910", border: "1px solid #111827", borderRadius: 8, padding: 10, maxHeight: 170, overflowY: "auto" }}>
                <div style={{ fontSize: 9, color: "#2d3b50", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Log</div>
                {logs.map((l, i) => <div key={i} style={{ fontSize: 10, color: "#3d4f68", lineHeight: 1.8 }}>{l}</div>)}
                <div ref={logsEndRef} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
