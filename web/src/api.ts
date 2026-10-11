export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|; )docs_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'x-csrf-token': csrfToken(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.details);
  return data as T;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Incorrect email or password.',
  invalid_totp: 'Incorrect verification code.',
  totp_required: 'Enter your verification code.',
  too_many_attempts: 'Too many attempts. Try again in 15 minutes.',
  wrong_current_password: 'Current password is incorrect.',
  same_password: 'The new password must be different from the current one.',
  email_exists: 'A user with this email already exists.',
  last_admin: 'The last active admin cannot be removed or disabled.',
  cannot_disable_self: 'You cannot disable your own account.',
  cannot_delete_self: 'You cannot delete your own account.',
  already_set_up: 'Setup has already been completed.',
  bad_setup_token: 'Incorrect setup token.',
  '2fa_required_by_admin': '2FA is required by an admin and cannot be turned off.',
  forbidden: 'You do not have permission to do this.',
  invalid: 'The information you entered is not valid.',
  network: 'Network error. Check your connection and try again.',
  slug_taken: 'This slug is already in use.',
  not_a_pdf: 'The file is not a valid PDF.',
  pdf_unreadable: 'The PDF could not be read (it may be corrupted).',
  pdf_encrypted: 'Password-protected PDFs cannot be uploaded. Remove the password first.',
  too_many_pages: 'The PDF has too many pages.',
  pdf_timeout: 'Processing the PDF timed out.',
  pdf_render_failed: 'The PDF could not be converted to pages.',
  file_too_large: 'The file is too large (100 MB maximum).',
  file_required: 'Choose a PDF file.',
  destination_required: 'A destination URL is required.',
  expiry_in_past: 'The expiry date must be in the future.',
  password_not_supported_for_url: 'Passwords are not supported for short URLs.',
  not_found: 'Not found.',
  busy: 'The pages of this link are being re-rendered. Try again in a moment.',
  logo_too_large: 'The logo file is too large (1 MB maximum, 512 KB for SVG).',
  logo_bad_format: 'Unsupported logo format. Use PNG, JPEG, WebP, GIF or SVG.',
  not_an_svg: 'The file is not a valid SVG.',
  icon_too_small: 'The app icon must be at least 192 x 192 pixels (512 x 512 recommended).',
  svg_unsafe: 'This SVG contains scripts or active content and cannot be used.',
  svg_external_reference: 'This SVG references external or embedded resources. Export it as a plain vector SVG, or upload a PNG.',
  bad_origin: 'Request blocked (origin mismatch). Reload the page and try again.',
  bad_csrf: 'Your session expired. Reload the page and try again.',
  too_many_requests: 'Too many requests. Slow down and try again.',
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { fieldErrors?: Record<string, string[]> } | undefined;
    const first = d?.fieldErrors && Object.values(d.fieldErrors).flat()[0];
    return first ?? MESSAGES[e.code] ?? `Error: ${e.code}`;
  }
  return 'An unexpected error occurred.';
}

/** Multipart upload (e.g. logos). Includes the CSRF header. */
export async function apiForm<T = unknown>(path: string, form: FormData, method = 'POST'): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken() }, body: form });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.details);
  return data as T;
}
