"use client";

import JSZip, { type JSZipObject } from "jszip";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { createContact, getContactsByKeys } from "@/app/actions/contacts";
import { getLastSendStatusForZip } from "@/app/actions/send-logs";
import type { Contact } from "@/lib/contacts/types";

type ParseSource = "manifest" | "fallback";
type ReviewFilter = "All" | "Pending" | "Failed" | "Blocked" | "Sent";
type ReviewStatus = "Pending" | "Blocked" | "Sent" | "Failed";

type ParsedBillRow = {
  account_key: string;
  pdf_filename: string;
  zip_entry_path: string;
  trade_date: string | null;
};

type BillRow = ParsedBillRow & {
  contact_name: string | null;
  contact_email: string | null;
  status: "Pending" | "Blocked";
};

type ZipSummary = {
  zipFilename: string;
  rowCount: number;
  source: ParseSource;
};

type AddContactState = {
  account_key: string;
  name: string;
  email: string;
  error: string;
};

type SendState = "idle" | "sending" | "sent" | "failed";

type RowSendState = {
  send_state: SendState;
  send_error?: string;
};

type LastLogStatus = {
  status: "sent" | "failed" | null;
  sent_at: string | null;
};

function getBaseName(pathname: string): string {
  const parts = pathname.split("/");
  return parts[parts.length - 1] ?? pathname;
}

function normalizeAccountKey(value: unknown): string {
  return String(value ?? "").trim();
}

function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

function isIgnoredAdminPdf(filename: string): boolean {
  const baseName = getBaseName(filename);
  return (
    baseName.startsWith("Bill_Admin_") ||
    baseName.startsWith("Summary_Admin_Closing_Adjustment_")
  );
}

function getStatusFromEmail(email: string | null): "Pending" | "Blocked" {
  return email ? "Pending" : "Blocked";
}

function uniqueAccountKeys(keys: string[]): string[] {
  return Array.from(
    new Set(keys.map((key) => normalizeAccountKey(key)).filter(Boolean))
  );
}

function mergeRowsWithContacts(
  rows: ParsedBillRow[],
  contactsByKey: Record<string, Contact>
): BillRow[] {
  return rows.map((row) => {
    const contact = contactsByKey[row.account_key];
    const contactEmail = contact?.email ?? null;

    return {
      ...row,
      contact_name: contact?.name ?? null,
      contact_email: contactEmail,
      status: getStatusFromEmail(contactEmail)
    };
  });
}

function parseFallbackRows(zip: JSZip): ParsedBillRow[] {
  const rows: ParsedBillRow[] = [];
  const files = Object.values(zip.files);

  for (const file of files) {
    if (file.dir) {
      continue;
    }

    const baseName = getBaseName(file.name);

    if (!baseName.startsWith("Bill_")) {
      continue;
    }

    if (!isPdf(baseName) || isIgnoredAdminPdf(baseName)) {
      continue;
    }

    const withoutPrefix = baseName.slice("Bill_".length);
    const firstUnderscoreIndex = withoutPrefix.indexOf("_");

    if (firstUnderscoreIndex <= 0) {
      continue;
    }

    const accountKey = normalizeAccountKey(
      withoutPrefix.slice(0, firstUnderscoreIndex)
    );
    if (!accountKey) {
      continue;
    }

    const tradeDateValue = withoutPrefix.slice(
      firstUnderscoreIndex + 1,
      withoutPrefix.length - ".pdf".length
    );

    rows.push({
      account_key: accountKey,
      pdf_filename: baseName,
      zip_entry_path: file.name,
      trade_date: tradeDateValue.trim() || null
    });
  }

  return rows;
}

function findPdfEntry(zip: JSZip, row: BillRow): JSZipObject | null {
  const directPathMatch = zip.file(row.zip_entry_path);
  if (directPathMatch && !directPathMatch.dir) {
    return directPathMatch;
  }

  const directFilenameMatch = zip.file(row.pdf_filename);
  if (directFilenameMatch && !directFilenameMatch.dir) {
    return directFilenameMatch;
  }

  const targetBaseName = getBaseName(row.pdf_filename);
  for (const file of Object.values(zip.files)) {
    if (file.dir) {
      continue;
    }

    if (getBaseName(file.name) === targetBaseName) {
      return file;
    }
  }

  return null;
}

function getRowId(row: BillRow): string {
  return `${row.account_key}::${row.zip_entry_path}::${row.pdf_filename}`;
}

function getDefaultSendState(): RowSendState {
  return { send_state: "idle" };
}

function toBase64(arrayBuffer: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([arrayBuffer], { type: "application/pdf" });
    const reader = new FileReader();

    reader.onloadend = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to encode PDF."));
        return;
      }

      const base64 = reader.result.split(",", 2)[1] ?? "";
      resolve(base64);
    };

    reader.onerror = () => {
      reject(new Error("Failed to encode PDF."));
    };

    reader.readAsDataURL(blob);
  });
}

function getReviewStatus(
  row: BillRow,
  rowSendState: RowSendState,
  lastLogStatus: LastLogStatus | null
): ReviewStatus {
  if (row.status === "Blocked") {
    return "Blocked";
  }

  if (rowSendState.send_state === "sent") {
    return "Sent";
  }

  if (rowSendState.send_state === "failed") {
    return "Failed";
  }

  if (lastLogStatus?.status === "sent") {
    return "Sent";
  }

  if (lastLogStatus?.status === "failed") {
    return "Failed";
  }

  return "Pending";
}

export default function UploadSendConsole() {
  const zipRef = useRef<JSZip | null>(null);
  const createdBlobUrlsRef = useRef<string[]>([]);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);

  const [rows, setRows] = useState<BillRow[]>([]);
  const [rowSendStates, setRowSendStates] = useState<Record<string, RowSendState>>(
    {}
  );
  const [selectedRowIds, setSelectedRowIds] = useState<Record<string, boolean>>({});
  const [skipAlreadySent, setSkipAlreadySent] = useState(true);
  const [lastLogStatusByKey, setLastLogStatusByKey] = useState<
    Record<string, LastLogStatus>
  >({});
  const [summary, setSummary] = useState<ZipSummary | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [isParsingZip, setIsParsingZip] = useState(false);
  const [isMutating, startMutation] = useTransition();
  const [isSendingAll, setIsSendingAll] = useState(false);
  const [actionError, setActionError] = useState("");
  const [addContactState, setAddContactState] = useState<AddContactState | null>(
    null
  );
  const [activeFilter, setActiveFilter] = useState<ReviewFilter>("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [showOnlyPending, setShowOnlyPending] = useState(false);

  useEffect(() => {
    return () => {
      createdBlobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      createdBlobUrlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const rowIds = new Set(rows.map((row) => getRowId(row)));
    setSelectedRowIds((current) => {
      const next: Record<string, boolean> = {};

      for (const [rowId, isSelected] of Object.entries(current)) {
        if (isSelected && rowIds.has(rowId)) {
          next[rowId] = true;
        }
      }

      return next;
    });
  }, [rows]);

  const zipFilename = summary?.zipFilename.trim() ?? "";

  const rowsWithReviewStatus = useMemo(() => {
    return rows.map((row) => {
      const rowId = getRowId(row);
      const rowSendState = rowSendStates[rowId] ?? getDefaultSendState();
      const lastLogStatus = lastLogStatusByKey[row.account_key] ?? null;

      return {
        row,
        rowId,
        rowSendState,
        lastLogStatus,
        reviewStatus: getReviewStatus(row, rowSendState, lastLogStatus)
      };
    });
  }, [rows, rowSendStates, lastLogStatusByKey]);

  const counts = useMemo(() => {
    const initial = {
      Pending: 0,
      Blocked: 0,
      Sent: 0,
      Failed: 0
    } as const;

    return rowsWithReviewStatus.reduce(
      (acc, item) => {
        acc[item.reviewStatus] += 1;
        return acc;
      },
      { ...initial }
    );
  }, [rowsWithReviewStatus]);

  const selectedPendingCount = useMemo(() => {
    return rowsWithReviewStatus.filter((item) => {
      if (!selectedRowIds[item.rowId]) {
        return false;
      }

      return item.row.status === "Pending";
    }).length;
  }, [rowsWithReviewStatus, selectedRowIds]);

  const visibleRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return rowsWithReviewStatus.filter((item) => {
      if (showOnlyPending && item.reviewStatus !== "Pending") {
        return false;
      }

      if (activeFilter !== "All" && item.reviewStatus !== activeFilter) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      return (
        item.row.account_key.toLowerCase().includes(normalizedSearch) ||
        (item.row.contact_name ?? "").toLowerCase().includes(normalizedSearch) ||
        (item.row.contact_email ?? "").toLowerCase().includes(normalizedSearch)
      );
    });
  }, [rowsWithReviewStatus, showOnlyPending, activeFilter, searchTerm]);

  const visiblePendingRows = useMemo(() => {
    return visibleRows.filter((item) => item.row.status === "Pending");
  }, [visibleRows]);

  const selectedVisiblePendingCount = useMemo(() => {
    return visiblePendingRows.filter((item) => Boolean(selectedRowIds[item.rowId])).length;
  }, [visiblePendingRows, selectedRowIds]);

  const allVisiblePendingSelected =
    visiblePendingRows.length > 0 &&
    selectedVisiblePendingCount === visiblePendingRows.length;
  const someVisiblePendingSelected =
    selectedVisiblePendingCount > 0 &&
    selectedVisiblePendingCount < visiblePendingRows.length;

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = someVisiblePendingSelected;
    }
  }, [someVisiblePendingSelected]);

  async function parseUploadedZip(file: File) {
    setIsParsingZip(true);
    setMessages([]);
    setActionError("");
    setAddContactState(null);
    setRowSendStates({});
    setSelectedRowIds({});
    setLastLogStatusByKey({});

    try {
      const zip = await JSZip.loadAsync(file);
      const parseMessages: string[] = [];

      let source: ParseSource = "fallback";
      let parsedRows: ParsedBillRow[] = [];

      const manifestFile = zip.file("manifest.json");
      if (manifestFile) {
        const manifestRawText = await manifestFile.async("string");

        try {
          const manifestData = JSON.parse(manifestRawText) as {
            trade_date?: unknown;
            success?: unknown;
          };

          source = "manifest";
          const tradeDate =
            typeof manifestData.trade_date === "string" &&
            manifestData.trade_date.trim()
              ? manifestData.trade_date.trim()
              : null;
          const manifestSuccess = Array.isArray(manifestData.success)
            ? manifestData.success
            : [];

          parsedRows = manifestSuccess.flatMap((item): ParsedBillRow[] => {
            const entry =
              item !== null && typeof item === "object"
                ? (item as Record<string, unknown>)
                : null;
            if (!entry) {
              return [];
            }

            const accountKey = normalizeAccountKey(entry.key);
            const pdfPath = String(entry.pdf ?? "").trim();
            if (!accountKey || !pdfPath) {
              return [];
            }

            if (!isPdf(pdfPath) || isIgnoredAdminPdf(pdfPath)) {
              return [];
            }

            return [
              {
                account_key: accountKey,
                pdf_filename: getBaseName(pdfPath),
                zip_entry_path: pdfPath,
                trade_date: tradeDate
              }
            ];
          });
        } catch {
          parseMessages.push("manifest.json invalid JSON");
        }
      }

      if (source !== "manifest") {
        source = "fallback";
        parsedRows = parseFallbackRows(zip);
      }

      if (parsedRows.length === 0) {
        parseMessages.push("No bill PDFs found");
        zipRef.current = zip;
        setRows([]);
        setRowSendStates({});
        setSelectedRowIds({});
        setLastLogStatusByKey({});
        setSummary({
          zipFilename: file.name,
          rowCount: 0,
          source
        });
        setMessages(parseMessages);
        return;
      }

      const accountKeys = uniqueAccountKeys(parsedRows.map((row) => row.account_key));
      const contactsByKey = await getContactsByKeys(accountKeys);
      const latestStatusByKey = await getLastSendStatusForZip(file.name, accountKeys);
      const mergedRows = mergeRowsWithContacts(parsedRows, contactsByKey);

      zipRef.current = zip;
      setRows(mergedRows);
      setRowSendStates({});
      setSelectedRowIds({});
      setLastLogStatusByKey(latestStatusByKey);
      setSummary({
        zipFilename: file.name,
        rowCount: mergedRows.length,
        source
      });
      setMessages(parseMessages);
    } catch (error) {
      setRows([]);
      setRowSendStates({});
      setSelectedRowIds({});
      setLastLogStatusByKey({});
      setSummary(null);
      setMessages([
        error instanceof Error ? error.message : "Failed to parse ZIP file."
      ]);
    } finally {
      setIsParsingZip(false);
    }
  }

  function setRowSendState(
    rowId: string,
    send_state: SendState,
    send_error?: string
  ) {
    setRowSendStates((current) => ({
      ...current,
      [rowId]: {
        send_state,
        send_error
      }
    }));
  }

  function shouldSkipRowBecauseSentEarlier(row: BillRow): boolean {
    if (!skipAlreadySent) {
      return false;
    }

    return (lastLogStatusByKey[row.account_key]?.status ?? null) === "sent";
  }

  function setRowSelected(rowId: string, selected: boolean) {
    setSelectedRowIds((current) => {
      if (selected) {
        return {
          ...current,
          [rowId]: true
        };
      }

      const next = { ...current };
      delete next[rowId];
      return next;
    });
  }

  function setAllVisiblePendingRowsSelected(selected: boolean) {
    if (!selected) {
      const visibleIds = new Set(visiblePendingRows.map((item) => item.rowId));
      setSelectedRowIds((current) => {
        const next = { ...current };
        for (const rowId of visibleIds) {
          delete next[rowId];
        }
        return next;
      });
      return;
    }

    const visibleIds = visiblePendingRows.map((item) => item.rowId);
    setSelectedRowIds((current) => {
      const next = { ...current };
      for (const rowId of visibleIds) {
        next[rowId] = true;
      }
      return next;
    });
  }

  async function refreshLastLogStatusForKeys(keysToRefresh?: string[]) {
    const normalizedKeys = keysToRefresh?.length
      ? uniqueAccountKeys(keysToRefresh)
      : uniqueAccountKeys(rows.map((row) => row.account_key));

    if (!zipFilename || normalizedKeys.length === 0) {
      if (!zipFilename) {
        setLastLogStatusByKey({});
      }
      return;
    }

    const latestStatus = await getLastSendStatusForZip(zipFilename, normalizedKeys);
    setLastLogStatusByKey((current) => {
      const next = keysToRefresh?.length ? { ...current } : {};

      for (const key of normalizedKeys) {
        const latestForKey = latestStatus[key];

        if (latestForKey) {
          next[key] = latestForKey;
        } else {
          delete next[key];
        }
      }

      return next;
    });
  }

  async function syncContactsForKeys(keysToRefresh: string[]) {
    const uniqueKeys = uniqueAccountKeys(keysToRefresh);
    if (uniqueKeys.length === 0) {
      return;
    }

    const keySet = new Set(uniqueKeys);
    const contactsByKey = await getContactsByKeys(uniqueKeys);

    setRows((currentRows) =>
      currentRows.map((row) => {
        if (!keySet.has(row.account_key)) {
          return row;
        }

        const contact = contactsByKey[row.account_key];
        const contactEmail = contact?.email ?? null;

        return {
          ...row,
          contact_name: contact?.name ?? null,
          contact_email: contactEmail,
          status: getStatusFromEmail(contactEmail)
        };
      })
    );
  }

  function openAddContact(accountKey: string) {
    setActionError("");
    setAddContactState({
      account_key: accountKey,
      name: "",
      email: "",
      error: ""
    });
  }

  function closeAddContact() {
    setAddContactState(null);
  }

  function submitAddContact() {
    if (!addContactState) {
      return;
    }

    setActionError("");

    startMutation(async () => {
      const result = await createContact({
        account_key: addContactState.account_key,
        name: addContactState.name,
        email: addContactState.email
      });

      if (!result.ok) {
        setAddContactState((current) =>
          current
            ? {
                ...current,
                error: result.error
              }
            : current
        );
        return;
      }

      await syncContactsForKeys([addContactState.account_key]);
      await refreshLastLogStatusForKeys([addContactState.account_key]);
      setAddContactState(null);
    });
  }

  async function handleViewPdf(row: BillRow) {
    setActionError("");

    try {
      const zip = zipRef.current;
      if (!zip) {
        setActionError("ZIP data is not available. Re-upload the file.");
        return;
      }

      const pdfEntry = findPdfEntry(zip, row);
      if (!pdfEntry) {
        setActionError(`Could not find PDF in ZIP: ${row.pdf_filename}`);
        return;
      }

      const pdfArrayBuffer = await pdfEntry.async("arraybuffer");
      const pdfBlob = new Blob([pdfArrayBuffer], { type: "application/pdf" });
      const blobUrl = URL.createObjectURL(pdfBlob);
      createdBlobUrlsRef.current.push(blobUrl);
      window.open(blobUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not open PDF."
      );
    }
  }

  async function sendEmailForRow(row: BillRow): Promise<boolean> {
    const rowId = getRowId(row);
    const currentState = rowSendStates[rowId]?.send_state ?? "idle";

    if (currentState === "sending") {
      return false;
    }

    if (!row.contact_email) {
      setRowSendState(rowId, "failed", "No contact email available.");
      return false;
    }

    if (!zipFilename) {
      setRowSendState(
        rowId,
        "failed",
        "ZIP filename is unavailable. Re-upload the file."
      );
      return false;
    }

    setActionError("");
    setRowSendState(rowId, "sending");

    try {
      const zip = zipRef.current;
      if (!zip) {
        throw new Error("ZIP data is not available. Re-upload the file.");
      }

      const pdfEntry = findPdfEntry(zip, row);
      if (!pdfEntry) {
        throw new Error(`Could not find PDF in ZIP: ${row.pdf_filename}`);
      }

      const pdfArrayBuffer = await pdfEntry.async("arraybuffer");
      const pdfBase64 = await toBase64(pdfArrayBuffer);

      const response = await fetch("/api/send-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          zip_filename: zipFilename,
          account_key: row.account_key,
          trade_date: row.trade_date,
          to_email: row.contact_email,
          to_name: row.contact_name,
          filename: row.pdf_filename,
          pdf_base64: pdfBase64
        }),
        credentials: "same-origin"
      });

      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;

      if (!response.ok || !payload?.ok) {
        const errorMessage = payload?.error ?? "Failed to send email.";
        setRowSendState(rowId, "failed", errorMessage);
        return false;
      }

      setRowSendState(rowId, "sent");
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to send email.";
      setRowSendState(rowId, "failed", errorMessage);
      return false;
    } finally {
      await refreshLastLogStatusForKeys([row.account_key]);
    }
  }

  async function sendPending() {
    if (isSendingAll) {
      return;
    }

    if (!zipFilename) {
      setActionError("ZIP filename is unavailable. Re-upload the file.");
      return;
    }

    setActionError("");
    setIsSendingAll(true);

    try {
      const rowsToSend = rows.filter((row) => {
        if (row.status !== "Pending") {
          return false;
        }

        if (shouldSkipRowBecauseSentEarlier(row)) {
          return false;
        }

        const rowId = getRowId(row);
        return rowSendStates[rowId]?.send_state !== "sent";
      });

      for (const row of rowsToSend) {
        await sendEmailForRow(row);
      }
    } finally {
      setIsSendingAll(false);
    }
  }

  async function sendSelectedPendingRows() {
    if (isSendingAll) {
      return;
    }

    if (!zipFilename) {
      setActionError("ZIP filename is unavailable. Re-upload the file.");
      return;
    }

    const rowsToSend = rows.filter((row) => {
      const rowId = getRowId(row);

      if (!selectedRowIds[rowId] || row.status !== "Pending") {
        return false;
      }

      if (shouldSkipRowBecauseSentEarlier(row)) {
        return false;
      }

      return rowSendStates[rowId]?.send_state !== "sent";
    });

    if (rowsToSend.length === 0) {
      setActionError("No eligible selected rows to send.");
      return;
    }

    setActionError("");
    setIsSendingAll(true);

    try {
      for (const row of rowsToSend) {
        await sendEmailForRow(row);
      }
    } finally {
      setIsSendingAll(false);
    }
  }

  async function retryAllFailed() {
    if (isSendingAll) {
      return;
    }

    if (!zipFilename) {
      setActionError("ZIP filename is unavailable. Re-upload the file.");
      return;
    }

    const rowsToRetry = rows.filter((row) => {
      if (row.status !== "Pending") {
        return false;
      }

      const logStatus = lastLogStatusByKey[row.account_key]?.status ?? null;
      if (logStatus !== "failed") {
        return false;
      }

      const rowId = getRowId(row);
      return rowSendStates[rowId]?.send_state !== "sent";
    });

    if (rowsToRetry.length === 0) {
      setActionError("No failed rows to retry.");
      return;
    }

    setActionError("");
    setIsSendingAll(true);

    try {
      for (const row of rowsToRetry) {
        await sendEmailForRow(row);
      }
    } finally {
      setIsSendingAll(false);
    }
  }

  const hasRows = rows.length > 0;
  const failedCount = counts.Failed;

  return (
    <section className="upload-flow">
      <section className="panel-section">
        <div className="section-headline">
          <h2 className="section-title">Upload</h2>
          <p className="section-note">Add one ZIP batch to start review and sending.</p>
        </div>

        <label className="zip-dropzone">
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => {
              const selectedFile = event.target.files?.[0];
              if (!selectedFile) {
                return;
              }

              void parseUploadedZip(selectedFile);
              event.currentTarget.value = "";
            }}
            className="zip-input"
            disabled={isParsingZip || isMutating || isSendingAll}
          />
          <span className="zip-dropzone-title">Drop ZIP here or click to upload</span>
          <span className="zip-dropzone-subtitle">
            Accepts one .zip file with bill PDFs and optional manifest.json
          </span>
        </label>

        {isParsingZip ? (
          <div className="message message-success" role="status">
            Parsing ZIP...
          </div>
        ) : null}

        {summary ? (
          <div className="batch-strip">
            <div className="batch-main">
              <strong>{summary.zipFilename}</strong>
              <span>•</span>
              <span>{summary.rowCount} rows parsed</span>
            </div>
            <details className="summary-details">
              <summary>Details</summary>
              <div className="summary-details-body">
                <p>
                  {summary.source === "manifest"
                    ? "Using manifest.json"
                    : "Using filename fallback"}
                </p>
                <p>Audit logging: enabled</p>
              </div>
            </details>
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <div className="section-headline">
          <h2 className="section-title">Review</h2>
          <p className="section-note">Filter rows and verify recipients before sending.</p>
        </div>

        {summary ? (
          <div className="summary-strip">
            <div className="summary-left">
              <span className="summary-file">{summary.zipFilename}</span>
              <span>{summary.rowCount} rows</span>
            </div>
            <div className="summary-counts">
              <span className="count-pill count-pill-pending">Pending {counts.Pending}</span>
              <span className="count-pill count-pill-blocked">Blocked {counts.Blocked}</span>
              <span className="count-pill count-pill-sent">Sent {counts.Sent}</span>
              <span className="count-pill count-pill-failed">Failed {counts.Failed}</span>
            </div>
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <p>Upload a ZIP to begin.</p>
          </div>
        )}

        <div className="review-controls">
          <div className="review-search-row">
            <input
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search account key / name / email"
              className="text-input"
              aria-label="Search bill rows"
            />
            <div className="review-toggle-group">
              <label className="pending-toggle">
                <input
                  type="checkbox"
                  checked={showOnlyPending}
                  onChange={(event) => setShowOnlyPending(event.target.checked)}
                />
                <span>Show only pending</span>
              </label>
            </div>
          </div>

          <div className="filter-row" role="tablist" aria-label="Status filter">
            {(["All", "Pending", "Failed", "Blocked", "Sent"] as const).map(
              (filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`filter-chip ${activeFilter === filter ? "filter-chip-active" : ""}`}
                  onClick={() => setActiveFilter(filter)}
                >
                  {filter}
                </button>
              )
            )}
          </div>
        </div>
      </section>

      {messages.map((message, index) => (
        <div className="message message-error" role="alert" key={`${message}-${index}`}>
          {message}
        </div>
      ))}

      {actionError ? (
        <div className="message message-error" role="alert">
          {actionError}
        </div>
      ) : null}

      {addContactState ? (
        <div className="contact-form-panel">
          <div className="contact-form-grid">
            <label className="field-label">
              Account Key
              <input
                type="text"
                value={addContactState.account_key}
                disabled
                className="text-input"
              />
            </label>

            <label className="field-label">
              Name
              <input
                type="text"
                value={addContactState.name}
                onChange={(event) =>
                  setAddContactState((current) =>
                    current
                      ? {
                          ...current,
                          name: event.target.value
                        }
                      : current
                  )
                }
                className="text-input"
                placeholder="Optional"
                disabled={isParsingZip || isMutating}
              />
            </label>

            <label className="field-label">
              Email
              <input
                type="email"
                value={addContactState.email}
                onChange={(event) =>
                  setAddContactState((current) =>
                    current
                      ? {
                          ...current,
                          email: event.target.value
                        }
                      : current
                  )
                }
                className="text-input"
                placeholder="name@example.com"
                disabled={isParsingZip || isMutating}
                required
              />
            </label>
          </div>

          <div className="contact-form-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={submitAddContact}
              disabled={isParsingZip || isMutating}
            >
              Save Contact
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={closeAddContact}
              disabled={isParsingZip || isMutating}
            >
              Cancel
            </button>
          </div>

          {addContactState.error ? (
            <div className="message message-error" role="alert">
              {addContactState.error}
            </div>
          ) : null}
        </div>
      ) : null}

      {hasRows ? (
        <div className="table-zone">
          {counts.Blocked > 0 ? (
            <div className="blocked-banner">
              <span>
                {counts.Blocked} blocked {"\u2014"} add contacts to enable sending.
              </span>
              <Link className="button button-secondary button-sm" href="/contacts">
                Go to Contacts
              </Link>
            </div>
          ) : null}

          <div className="console-action-bar">
            <div className="action-bar-left">
              {selectedPendingCount > 0 ? (
                <span className="action-selection">Selected: {selectedPendingCount}</span>
              ) : (
                <span className="action-selection-muted">Select rows to send only those recipients.</span>
              )}
              <label className="pending-toggle">
                <input
                  type="checkbox"
                  checked={skipAlreadySent}
                  onChange={(event) => setSkipAlreadySent(event.target.checked)}
                  disabled={isParsingZip || isMutating || isSendingAll}
                />
                <span>Skip already sent</span>
              </label>
            </div>

            <div className="action-bar-right">
              {counts.Pending > 0 ? (
                <button
                  type="button"
                  className="button button-primary button-sm"
                  onClick={() => {
                    void sendPending();
                  }}
                  disabled={!hasRows || !zipFilename || isParsingZip || isMutating || isSendingAll}
                >
                  {isSendingAll ? "Sending..." : "Send pending"}
                </button>
              ) : null}

              {failedCount > 0 ? (
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => {
                    void retryAllFailed();
                  }}
                  disabled={!hasRows || !zipFilename || isParsingZip || isMutating || isSendingAll}
                >
                  Retry failed
                </button>
              ) : null}

              {selectedPendingCount > 0 ? (
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => {
                    void sendSelectedPendingRows();
                  }}
                  disabled={
                    !hasRows ||
                    !zipFilename ||
                    isParsingZip ||
                    isMutating ||
                    isSendingAll
                  }
                >
                  Send selected
                </button>
              ) : null}
            </div>
          </div>

          <div className="contacts-table-wrap upload-table-wrap">
            <table className="contacts-table upload-table">
              <thead>
                <tr>
                  <th className="select-col">
                    <input
                      ref={selectAllCheckboxRef}
                      type="checkbox"
                      checked={allVisiblePendingSelected}
                      onChange={(event) => {
                        setAllVisiblePendingRowsSelected(event.target.checked);
                      }}
                      aria-label="Select all visible pending rows"
                      disabled={visiblePendingRows.length === 0 || isParsingZip || isMutating || isSendingAll}
                    />
                  </th>
                  <th>Account Key</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>PDF</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((item) => {
                  const { row, rowId, rowSendState, lastLogStatus, reviewStatus } = item;
                  const isRowSelected = Boolean(selectedRowIds[rowId]);
                  const statusLabel =
                    reviewStatus === "Sent" &&
                    lastLogStatus?.status === "sent" &&
                    rowSendState.send_state !== "sent"
                      ? "Sent earlier"
                      : reviewStatus === "Failed" &&
                          lastLogStatus?.status === "failed" &&
                          rowSendState.send_state !== "failed"
                        ? "Failed earlier"
                        : reviewStatus;
                  const actionLabel =
                    rowSendState.send_state === "sending"
                      ? "Sending..."
                      : rowSendState.send_state === "sent"
                        ? "Sent"
                        : rowSendState.send_state === "failed" || reviewStatus === "Failed"
                          ? "Retry"
                          : "Send";

                  return (
                    <tr key={rowId}>
                      <td className="select-col">
                        <input
                          type="checkbox"
                          checked={isRowSelected}
                          onChange={(event) => {
                            setRowSelected(rowId, event.target.checked);
                          }}
                          aria-label={`Select ${row.account_key}`}
                          disabled={row.status === "Blocked" || isParsingZip || isMutating || isSendingAll}
                        />
                      </td>

                      <td>
                        <span className="account-key">{row.account_key}</span>
                      </td>

                      <td>
                        <span className="account-name">{row.contact_name ?? "—"}</span>
                      </td>

                      <td>
                        <span className="email-muted">{row.contact_email ?? "—"}</span>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="button button-secondary button-sm"
                          onClick={() => {
                            void handleViewPdf(row);
                          }}
                          disabled={isParsingZip || isMutating || isSendingAll}
                        >
                          View
                        </button>
                      </td>

                      <td>
                        <div className="status-cell">
                          <span
                            className={`status-pill ${
                              reviewStatus === "Pending"
                                ? "status-pending"
                                : reviewStatus === "Sent"
                                  ? statusLabel === "Sent earlier"
                                    ? "status-sent-earlier"
                                    : "status-sent"
                                  : reviewStatus === "Failed"
                                    ? "status-failed"
                                    : "status-blocked"
                            }`}
                          >
                            {statusLabel}
                          </span>
                        </div>
                      </td>

                      <td>
                        {row.status === "Pending" ? (
                          <div className="row-action-cell">
                            <button
                              type="button"
                              className="button button-secondary button-sm"
                              onClick={() => {
                                void sendEmailForRow(row);
                              }}
                              disabled={
                                !zipFilename ||
                                isParsingZip ||
                                isMutating ||
                                isSendingAll ||
                                rowSendState.send_state === "sending" ||
                                rowSendState.send_state === "sent"
                              }
                            >
                              {actionLabel}
                            </button>
                            {rowSendState.send_state === "failed" && rowSendState.send_error ? (
                              <span className="send-error-inline">{rowSendState.send_error}</span>
                            ) : null}
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="button button-primary button-sm"
                            onClick={() => openAddContact(row.account_key)}
                            disabled={isParsingZip || isMutating || isSendingAll}
                          >
                            Add contact
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
