import { ActionError, type RuntimeRequest, type RuntimeResult, type OperationValues } from './contract.ts';
import { ReferenceStore } from './references.ts';
import { readPage } from './actions/read-page.ts';
import { find } from './actions/find.ts';
import { pageText } from './actions/page-text.ts';
import { resolve } from './actions/resolve.ts';
import { formInput } from './actions/form-input.ts';
import { scrollTo } from './actions/scroll-to.ts';
import { fileInput } from './actions/file-input.ts';

export type RuntimeValue = OperationValues[Exclude<keyof OperationValues, 'file_input'>] | HTMLInputElement;

export class BrowserRuntime {
  private readonly refs = new ReferenceStore();

  async call(request: RuntimeRequest): Promise<RuntimeResult<RuntimeValue>> {
    try {
      this.refs.advance(request.args.base);
      const value = await this.execute(request);
      return { ok: true, value, nextRef: this.refs.next };
    } catch (error) {
      // Unexpected exception messages may contain secrets or page-controlled code/text.
      const failure =
        error instanceof ActionError
          ? { code: error.code, message: error.message }
          : { code: 'script_failed' as const, message: 'The page script failed' };
      return { ok: false, error: failure, nextRef: this.refs.next };
    }
  }

  private execute(request: RuntimeRequest): RuntimeValue | Promise<RuntimeValue> {
    switch (request.operation) {
      case 'read_page':
        return readPage(this.refs, request.args);
      case 'find':
        return find(this.refs, request.args);
      case 'page_text':
        return pageText(this.refs, request.args);
      case 'resolve':
        return resolve(this.refs, request.args);
      case 'form_input':
        return formInput(this.refs, request.args);
      case 'scroll_to':
        return scrollTo(this.refs, request.args);
      case 'file_input':
        return fileInput(this.refs, request.args);
      default:
        throw new ActionError('unsupported', 'Unsupported page operation');
    }
  }
}
