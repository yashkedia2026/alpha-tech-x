"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createContact,
  deleteContact,
  updateContact
} from "@/app/actions/contacts";
import type { Contact } from "@/lib/contacts/types";

type ContactsManagerProps = {
  initialContacts: Contact[];
};

type FormMode = "add" | "edit";

type FormState = {
  account_key: string;
  name: string;
  email: string;
};

const EMPTY_FORM: FormState = {
  account_key: "",
  name: "",
  email: ""
};

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString();
}

export default function ContactsManager({ initialContacts }: ContactsManagerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [searchTerm, setSearchTerm] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("add");
  const [formState, setFormState] = useState<FormState>(EMPTY_FORM);
  const [errorText, setErrorText] = useState("");

  const filteredContacts = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    if (!normalizedSearch) {
      return initialContacts;
    }

    return initialContacts.filter((contact) => {
      return (
        contact.account_key.toLowerCase().includes(normalizedSearch) ||
        (contact.name ?? "").toLowerCase().includes(normalizedSearch) ||
        contact.email.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [initialContacts, searchTerm]);

  const openAddForm = () => {
    setFormMode("add");
    setFormState(EMPTY_FORM);
    setErrorText("");
    setFormOpen(true);
  };

  const openEditForm = (contact: Contact) => {
    setFormMode("edit");
    setFormState({
      account_key: contact.account_key,
      name: contact.name ?? "",
      email: contact.email
    });
    setErrorText("");
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setErrorText("");
  };

  const handleSubmit = () => {
    setErrorText("");

    startTransition(async () => {
      const result =
        formMode === "add"
          ? await createContact({
              account_key: formState.account_key,
              name: formState.name,
              email: formState.email
            })
          : await updateContact(formState.account_key, {
              name: formState.name,
              email: formState.email
            });

      if (!result.ok) {
        setErrorText(result.error);
        return;
      }

      setFormOpen(false);
      setFormState(EMPTY_FORM);
      router.refresh();
    });
  };

  const handleDelete = (accountKey: string) => {
    const confirmed = window.confirm(
      `Delete contact for account key "${accountKey}"?`
    );
    if (!confirmed) {
      return;
    }

    setErrorText("");
    startTransition(async () => {
      const result = await deleteContact(accountKey);
      if (!result.ok) {
        setErrorText(result.error);
        return;
      }

      router.refresh();
    });
  };

  return (
    <section className="contacts-panel">
      <div className="contacts-top-row">
        <div>
          <h2>Contacts</h2>
          <p className="subtitle">Manage account_key to email mappings</p>
        </div>

        <button
          type="button"
          className="button button-primary"
          onClick={openAddForm}
          disabled={isPending}
        >
          Add Contact
        </button>
      </div>

      <div className="contacts-search">
        <input
          type="text"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Search account_key, name, or email"
          className="text-input"
          aria-label="Search contacts"
        />
      </div>

      {formOpen ? (
        <div className="contact-form-panel">
          <div className="contact-form-grid">
            <label className="field-label">
              Account Key
              <input
                type="text"
                value={formState.account_key}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    account_key: event.target.value
                  }))
                }
                className="text-input"
                placeholder="PR20"
                disabled={formMode === "edit" || isPending}
                required
              />
            </label>

            <label className="field-label">
              Name
              <input
                type="text"
                value={formState.name}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    name: event.target.value
                  }))
                }
                className="text-input"
                placeholder="Optional"
                disabled={isPending}
              />
            </label>

            <label className="field-label">
              Email
              <input
                type="email"
                value={formState.email}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    email: event.target.value
                  }))
                }
                className="text-input"
                placeholder="name@example.com"
                disabled={isPending}
                required
              />
            </label>
          </div>

          <div className="contact-form-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={handleSubmit}
              disabled={isPending}
            >
              {isPending
                ? "Saving..."
                : formMode === "add"
                  ? "Create Contact"
                  : "Save Changes"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={closeForm}
              disabled={isPending}
            >
              Cancel
            </button>
          </div>

          {errorText ? (
            <div className="message message-error" role="alert">
              {errorText}
            </div>
          ) : null}
        </div>
      ) : null}

      {errorText && !formOpen ? (
        <div className="message message-error" role="alert">
          {errorText}
        </div>
      ) : null}

      {initialContacts.length === 0 ? (
        <div className="empty-state">
          <p>No contacts yet.</p>
          <button
            type="button"
            className="button button-primary"
            onClick={openAddForm}
            disabled={isPending}
          >
            Add Contact
          </button>
        </div>
      ) : filteredContacts.length === 0 ? (
        <div className="empty-state">
          <p>No contacts match your search.</p>
        </div>
      ) : (
        <div className="contacts-table-wrap">
          <table className="contacts-table">
            <thead>
              <tr>
                <th>Account Key</th>
                <th>Name</th>
                <th>Email</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredContacts.map((contact) => (
                <tr key={contact.account_key}>
                  <td>{contact.account_key}</td>
                  <td>{contact.name ?? "-"}</td>
                  <td>{contact.email}</td>
                  <td>{formatUpdatedAt(contact.updated_at)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => openEditForm(contact)}
                        disabled={isPending}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button-danger"
                        onClick={() => handleDelete(contact.account_key)}
                        disabled={isPending}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
