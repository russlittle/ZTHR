/** What every console page shares: element lookup and the detail drawer. */
export const $ = (id: string) => document.getElementById(id) as HTMLElement;

let returnTo: HTMLElement | null = null;

export const drawer = {
  open(title: string, html: string, from: HTMLElement | null) {
    returnTo = from;
    $('dr-title').textContent = title;
    $('dr-body').innerHTML = html;
    $('drawer').hidden = false;
    $('dr-close').focus();
  },
  close() {
    $('drawer').hidden = true;
    returnTo?.focus();
    returnTo = null;
  },
};

document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'dr-close') drawer.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('drawer').hidden) drawer.close();
});
