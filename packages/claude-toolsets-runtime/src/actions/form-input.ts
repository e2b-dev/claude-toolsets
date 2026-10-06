import { ActionError } from '../contract.ts';
import type { OperationArgs } from '../contract.ts';
import type { ReferenceStore } from '../references.ts';
import { normalizeText, clip, quote } from '../text.ts';
import { isInert, isDisabled, isSecret, tick } from '../dom.ts';
import { roleOf, nameOf } from '../accessibility.ts';

export async function formInput(refs: ReferenceStore, args: OperationArgs['form_input']) {
  const ref = args.ref;
  const value = args.value;

  const fail = (message: string): never => {
    throw new ActionError('action_failed', ref + ' ' + message);
  };

  const ok = (summary: string) => ({ summary });

  let element = refs.lookup(ref);
  if (element.tagName === 'LABEL' && (element as HTMLLabelElement).control) {
    element = (element as HTMLLabelElement).control!;
  }
  const tag = element.tagName;
  const role = roleOf(element) || 'generic';
  if (value === undefined || value === null) {
    return fail('needs a value');
  }
  if (isInert(element)) {
    return fail('is inert (blocked by a modal or an inactive region); close the dialog first');
  }
  if (isDisabled(element)) {
    return fail('is disabled and cannot be changed');
  }
  const label = nameOf(element, role);
  const fieldName = ref + (label ? ' (' + quote(clip(label, 60)) + ')' : '');

  const dispatchChanges = () => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const toBoolean = (candidate: unknown) => {
    if (typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      return candidate !== 0;
    }
    const textValue = String(candidate).trim().toLowerCase();
    if (['true', 'on', 'yes', 'checked', 'check', '1'].includes(textValue)) {
      return true;
    }
    if (['false', 'off', 'no', 'unchecked', 'uncheck', '0', ''].includes(textValue)) {
      return false;
    }
    return null;
  };

  // The prototype's value setter, not the instance property, so React's value tracker sees a change.
  const setNativeProperty = (prop: string, val: unknown) => {
    for (let prototype = Object.getPrototypeOf(element); prototype; prototype = Object.getPrototypeOf(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, prop);
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, val);
        return;
      }
    }
    Reflect.set(element, prop, val);
  };

  if (
    tag === 'INPUT' &&
    ((element as HTMLInputElement).type === 'checkbox' || (element as HTMLInputElement).type === 'radio')
  ) {
    const input = element as HTMLInputElement;
    const checked = toBoolean(value);
    if (checked === null) {
      return fail('is a ' + input.type + '; pass true or false');
    }
    if (input.type === 'radio' && !checked) {
      if (!input.checked) {
        return ok(fieldName + ' is already unselected');
      }
      return fail('is a radio button and cannot be unselected; select another option in its group instead');
    }
    if (input.checked !== checked) {
      input.click();
    }
    if (input.checked !== checked) {
      setNativeProperty('checked', checked);
      dispatchChanges();
    }
    await tick();
    if (input.checked !== checked) {
      return fail('did not change; the page reverted it, try clicking it instead');
    }
    if (!checked) {
      return ok('Unchecked ' + fieldName);
    }
    return ok((input.type === 'radio' ? 'Selected ' : 'Checked ') + fieldName);
  }
  if (
    tag !== 'INPUT' &&
    tag !== 'SELECT' &&
    ['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(role)
  ) {
    const checked = toBoolean(value);
    if (checked === null) {
      return fail('is a ' + role + '; pass true or false');
    }
    if ((element.getAttribute('aria-checked') === 'true') !== checked) {
      (element as HTMLElement).click();
    }
    await tick();
    if ((element.getAttribute('aria-checked') === 'true') !== checked) {
      return fail('did not change after clicking it; try click instead');
    }
    return ok((checked ? 'Checked ' : 'Unchecked ') + fieldName);
  }
  if (tag === 'SELECT') {
    const select = element as HTMLSelectElement;
    const options = [...select.options];

    const text = (option: HTMLOptionElement) => normalizeText(option.label || option.text);

    const pick = (candidate: unknown) => {
      const textValue = String(candidate);
      const normalizedValue = normalizeText(textValue).toLowerCase();
      return (
        options.find((option) => option.value === textValue) ||
        options.find((option) => text(option) === normalizeText(textValue)) ||
        options.find((option) => text(option).toLowerCase() === normalizedValue) ||
        null
      );
    };

    const off = (option: HTMLOptionElement) =>
      option.disabled ||
      (option.parentElement &&
        option.parentElement.tagName === 'OPTGROUP' &&
        (option.parentElement as HTMLOptGroupElement).disabled);

    let asked;
    if (Array.isArray(value)) {
      asked = value;
    } else if (select.multiple && !pick(value)) {
      asked = String(value)
        .split(/\s*[,\n]\s*/)
        .filter(Boolean);
    } else {
      asked = [value];
    }
    if (!select.multiple && asked.length !== 1) {
      return fail('is a single-choice dropdown; pass one option');
    }
    const chosen = [];
    for (const requestedValue of asked) {
      const option = pick(requestedValue);
      if (!option) {
        return fail(
          'has no option ' +
            quote(clip(String(requestedValue), 60)) +
            '; options are ' +
            options
              .slice(0, 30)
              .map((candidate) => quote(clip(text(candidate), 40)))
              .join(', ') +
            (options.length > 30 ? ', ...' : ''),
        );
      }
      if (off(option)) {
        return fail('option ' + quote(clip(text(option), 60)) + ' is disabled');
      }
      chosen.push(option);
    }
    select.focus();
    if (select.multiple) {
      const set = new Set(chosen);
      for (const option of options) {
        option.selected = set.has(option);
      }
    } else {
      setNativeProperty('selectedIndex', options.indexOf(chosen[0]!));
    }
    dispatchChanges();
    await tick();
    const now = [...select.selectedOptions].map((option) => quote(clip(text(option), 60)));
    return ok('Selected ' + (now.length ? now.join(', ') : 'nothing') + ' in ' + fieldName);
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    const type = tag === 'INPUT' ? field.type : 'textarea';
    if (type === 'file') {
      return fail('is a file input; use an upload tool if this driver supports uploads');
    }
    if (['button', 'submit', 'reset', 'image'].includes(type)) {
      return fail('is a button; click it instead');
    }
    if (field.readOnly || element.getAttribute('aria-readonly') === 'true') {
      return fail('is read-only');
    }
    if (typeof value === 'object') {
      return fail('needs a single text value');
    }
    const textValue = String(value);
    const FORMATS: Record<string, string> = {
      date: 'YYYY-MM-DD',
      time: 'HH:MM',
      'datetime-local': 'YYYY-MM-DDTHH:MM',
      month: 'YYYY-MM',
      week: 'YYYY-Www',
      color: '#rrggbb',
      number: 'a number',
      range: 'a number',
    };
    const before = field.value;
    field.focus();
    setNativeProperty('value', textValue);
    if (textValue !== '' && field.value === '' && FORMATS[type]) {
      setNativeProperty('value', before);
      return fail('rejected ' + quote(clip(textValue, 60)) + '; a ' + type + ' input expects ' + FORMATS[type]);
    }
    dispatchChanges();
    await tick();
    if (isSecret(element)) {
      return ok('Set ' + fieldName + ' to a hidden value');
    }
    const now = field.value;
    return ok(
      'Set ' +
        fieldName +
        ' to ' +
        quote(clip(now, 100)) +
        (now !== textValue ? ' (the page adjusted the value you gave)' : ''),
    );
  }
  if ((element as HTMLElement).isContentEditable) {
    const editor = element as HTMLElement;
    if (typeof value === 'object') {
      return fail('needs a single text value');
    }
    const textValue = String(value);
    const ownerDocument = element.ownerDocument;
    editor.focus();
    let done = false;
    try {
      const selection = ownerDocument.getSelection();
      const range = ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      done = ownerDocument.execCommand(textValue ? 'insertText' : 'delete', false, textValue);
    } catch {
      // Fall back to replacing text when native editing is unavailable.
    }
    if (!done || normalizeText(editor.innerText) !== normalizeText(textValue)) {
      element.textContent = textValue;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textValue }));
    }
    await tick();
    return ok('Set ' + fieldName + ' to ' + quote(clip(normalizeText(editor.innerText), 100)));
  }
  if (role === 'combobox' || role === 'listbox') {
    return fail('is a custom ' + role + '; click it to open, then click an option');
  }
  return fail('is not a form field (it is a ' + role + '); use click or type instead');
}
