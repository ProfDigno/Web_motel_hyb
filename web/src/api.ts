export type WebAccount = { id: number; username: string; role: 'admin' | 'consulta' };
export type AuthResult = { user: WebAccount };

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type','application/json');
  if (['POST','PUT','PATCH','DELETE'].includes(method)) {
    const tokenResponse = await fetch('/api/csrf',{credentials:'include'});
    if (!tokenResponse.ok) throw new Error('No se pudo preparar la solicitud.');
    const token = await tokenResponse.json() as {token:string};
    headers.set('X-CSRF-Token',token.token);
  }
  const response = await fetch(url,{credentials:'include',...init,cache:'no-store',headers});
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login' && url !== '/api/change-password' && url !== '/api/me') window.dispatchEvent(new Event('auth-required'));
    throw new Error(body.error || 'Error de conexión');
  }
  return body as T;
}
