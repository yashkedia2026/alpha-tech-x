"use client";

import JSZip, { type JSZipObject } from "jszip";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createContact, getContactsByKeys } from "@/app/actions/contacts";
import { getLastSendStatusForZip } from "@/app/actions/send-logs";
import type { Contact } from "@/lib/contacts/types";

type ParseSource = "manifest" | "fallback";

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
  return Array.from(new Set(keys.map((key) => normalizeAccountKey(key)).filter(Boolean)));
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

  const pendingCount = useMemo(
    () => rows.filter((row) => row.status === "Pending").length,
    [rows]
  );
  const blockedCount = useMemo(
    () => rows.filter((row) => row.status === "Blocked").length,
    [rows]
  );

  const sentCount = useMemo(
    () =>
      rows.filter((row) => {
        const state = rowSendStates[getRowId(row)]?.send_state ?? "idle";
        return state === "sent";
      }).length,
    [rows, rowSendStates]
  );
  const zipFilename = summary?.zipFilename.trim() ?? "";
  const pendingRows = useMemo(
    () => rows.filter((row) => row.status === "Pending"),
    [rows]
  );
  const selectedPendingCount = useMemo(
    () => pendingRows.filter((row) => Boolean(selectedRowIds[getRowId(row)])).length,
    [pendingRows, selectedRowIds]
  );
  const allPendingSelected =
    pendingRows.length > 0 && selectedPendingCount === pendingRows.length;
  const somePendingSelected =
    selectedPendingCount > 0 && selectedPendingCount < pendingRows.length;

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = somePendingSelected;
    }
  }, [somePendingSelected]);

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

      const accountKeys = uniqueAccountKeys(
        parsedRows.map((row) => row.account_key)
      );
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

  function getRowSendState(row: BillRow): RowSendState {
    return rowSendStates[getRowId(row)] ?? getDefaultSendState();
  }

  function getLastLogStatusForRow(row: BillRow): LastLogStatus | null {
    return lastLogStatusByKey[row.account_key] ?? null;
  }

  function shouldSkipRowBecauseSentEarlier(row: BillRow): boolean {
    if (!skipAlreadySent) {
      return false;
    }

    return getLastLogStatusForRow(row)?.status === "sent";
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

  function setAllPendingRowsSelected(selected: boolean) {
    if (!selected) {
      setSelectedRowIds({});
      return;
    }

    const next: Record<string, boolean> = {};
    for (const row of pendingRows) {
      next[getRowId(row)] = true;
    }

    setSelectedRowIds(next);
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

  function refreshContacts(targetAccountKeys?: string[]) {
    const keysToRefresh = targetAccountKeys?.length
      ? uniqueAccountKeys(targetAccountKeys)
      : uniqueAccountKeys(rows.map((row) => row.account_key));

    if (keysToRefresh.length === 0) {
      return;
    }

    const keySet = new Set(keysToRefresh);
    setActionError("");

    startMutation(async () => {
      await syncContactsForKeys(Array.from(keySet));
    });
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
      setRowSendState(rowId, "failed", "ZIP filename is unavailable. Re-upload the file.");
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

  async function sendAllPending() {
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

      const logStatus = getLastLogStatusForRow(row);
      if (logStatus?.status !== "failed") {
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

  function renderLastLogBadge(row: BillRow) {
    const logStatus = getLastLogStatusForRow(row)?.status;

    if (logStatus === "sent") {
      return <span className="history-badge history-badge-sent">Sent earlier</span>;
    }

    if (logStatus === "failed") {
      return <span className="history-badge history-badge-failed">Failed earlier</span>;
    }

    return null;
  }

  function renderSendState(row: BillRow) {
    const sendState = getRowSendState(row);

    if (sendState.send_state === "idle") {
      return null;
    }

    const stateClass =
      sendState.send_state === "sending"
        ? "send-state-sending"
        : sendState.send_state === "sent"
          ? "send-state-sent"
          : "send-state-failed";

    const stateLabel =
      sendState.send_state === "sending"
        ? "Sending..."
        : sendState.send_state === "sent"
          ? "Sent ✅"
          : "Failed ❌";

    return (
      <div className="send-state-wrap">
        <span className={`send-state-badge ${stateClass}`}>{stateLabel}</span>
        {sendState.send_state === "failed" && sendState.send_error ? (
          <p className="send-state-error">{sendState.send_error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <section className="upload-panel">
      <div className="upload-controls">
        <label className="field-label upload-field">
          Upload Bills ZIP
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
            className="text-input"
            disabled={isParsingZip || isMutating || isSendingAll}
          />
        </label>

        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            void sendAllPending();
          }}
          disabled={
            rows.length === 0 ||
            !zipFilename ||
            isParsingZip ||
            isMutating ||
            isSendingAll
          }
        >
          {isSendingAll ? "Sending all..." : "Send All Pending"}
        </button>

        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            void sendSelectedPendingRows();
          }}
          disabled={
            rows.length === 0 ||
            selectedPendingCount === 0 ||
            !zipFilename ||
            isParsingZip ||
            isMutating ||
            isSendingAll
          }
        >
          Send Selected
        </button>

        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            void retryAllFailed();
          }}
          disabled={rows.length === 0 || !zipFilename || isParsingZip || isMutating || isSendingAll}
        >
          Retry All Failed
        </button>

        <button
          type="button"
          className="button button-secondary"
          onClick={() => refreshContacts()}
          disabled={rows.length === 0 || isParsingZip || isMutating || isSendingAll}
        >
          Refresh contacts
        </button>

        <label className="send-toggle">
          <input
            type="checkbox"
            checked={skipAlreadySent}
            onChange={(event) => {
              setSkipAlreadySent(event.target.checked);
            }}
            disabled={isParsingZip || isMutating || isSendingAll}
          />
          <span>Skip already sent</span>
        </label>
      </div>

      {isParsingZip ? (
        <div className="message message-success" role="status">
          Parsing ZIP...
        </div>
      ) : null}

      {summary ? (
        <div className="upload-summary">
          <p>
            <strong>{summary.zipFilename}</strong>
          </p>
          <p>{summary.rowCount} bill rows parsed</p>
          <p>
            {summary.source === "manifest"
              ? "Using manifest.json"
              : "Using filename fallback"}
          </p>
          <p>
            Pending: {pendingCount} | Blocked: {blockedCount}
          </p>
          <p>Sent: {sentCount}</p>
          <p>Audit logging: enabled</p>
        </div>
      ) : null}

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

      {rows.length > 0 ? (
        <div className="contacts-table-wrap">
          <table className="contacts-table">
            <thead>
              <tr>
                <th className="select-col">
                  <input
                    ref={selectAllCheckboxRef}
                    type="checkbox"
                    checked={allPendingSelected}
                    onChange={(event) => {
                      setAllPendingRowsSelected(event.target.checked);
                    }}
                    aria-label="Select all pending rows"
                    disabled={pendingRows.length === 0 || isParsingZip || isMutating || isSendingAll}
                  />
                </th>
                <th>Account Key</th>
                <th>Name</th>
                <th>Email</th>
                <th>PDF</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const rowId = getRowId(row);
                const isRowSelected = Boolean(selectedRowIds[rowId]);

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
                        disabled={
                          row.status === "Blocked" || isParsingZip || isMutating || isSendingAll
                        }
                      />
                    </td>
                    <td>{row.account_key}</td>
                    <td>{row.contact_name ?? "—"}</td>
                    <td>{row.contact_email ?? "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="button button-secondary"
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
                            row.status === "Pending" ? "status-pending" : "status-blocked"
                          }`}
                        >
                          {row.status}
                        </span>
                        {renderLastLogBadge(row)}
                      </div>
                    </td>
                    <td>
                      {row.status === "Pending" ? (
                        <div>
                          <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => {
                              void sendEmailForRow(row);
                            }}
                            disabled={
                              !zipFilename ||
                              isParsingZip ||
                              isMutating ||
                              isSendingAll ||
                              getRowSendState(row).send_state === "sending" ||
                              getRowSendState(row).send_state === "sent"
                            }
                          >
                            {getRowSendState(row).send_state === "failed"
                              ? "Retry"
                              : getRowSendState(row).send_state === "sending"
                                ? "Sending..."
                                : getRowSendState(row).send_state === "sent"
                                  ? "Sent"
                                  : "Send Email"}
                          </button>
                          {renderSendState(row)}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="button button-primary"
                          onClick={() => openAddContact(row.account_key)}
                          disabled={isParsingZip || isMutating || isSendingAll}
                        >
                          Add Contact
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
