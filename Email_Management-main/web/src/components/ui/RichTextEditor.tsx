import React, { useEffect, useMemo, useRef } from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import { PLACEHOLDER_CHIPS } from '../../lib/campaignValidation';

/**
 * ED-02: Quill 2 serializes every typed space as &nbsp;, so stored HTML had "Typed&nbsp;by&nbsp;keyboard".
 * Turn a single &nbsp; between words back into a normal space. Runs of spaces keep alternating
 * &nbsp; (so they still show), and a lone &nbsp; at the start/end of an element is kept.
 * Applied when the campaign is saved, not in onChange: react-quill-new resets the editor whenever
 * the value prop differs from its own output, which would move the cursor on every keystroke.
 */
export function normalizeEditorSpaces(html: string): string {
  return html.replace(/(?:&nbsp;| )*&nbsp;(?:&nbsp;| )*/g, (run, offset: number, all: string) => {
    const count = (run.match(/&nbsp;| /g) || []).length;
    if (count === 1) {
      const before = all[offset - 1];
      const after = all[offset + run.length];
      return before === undefined || before === '>' || after === undefined || after === '<' ? '&nbsp;' : ' ';
    }
    let out = '';
    for (let i = 0; i < count; i++) out += i % 2 === 0 ? ' ' : '&nbsp;';
    return out;
  });
}

/** Template data ready to save: the Blank Template rich-text body gets normal spaces (ED-02). */
export function withNormalizedBody(templateId: string, data: Record<string, string>): Record<string, string> {
  return templateId === 'simple' && data.body ? { ...data, body: normalizeEditorSpaces(data.body) } : data;
}

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  availablePlaceholders?: string[];
  onInsertPlaceholder?: (placeholder: string) => void;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write your message here...',
  error,
  availablePlaceholders = [],
  onInsertPlaceholder,
}: RichTextEditorProps) {
  const quillRef = useRef<ReactQuill | null>(null);

  const modules = useMemo(() => ({
    toolbar: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline'],
      [{ 'list': 'bullet' }, { 'list': 'ordered' }],
      [{ 'color': [] }, { 'background': [] }],
      ['link'],
      ['clean']
    ],
  }), []);

  const formats = [
    'header',
    'bold', 'italic', 'underline',
    // N-19: in Quill 2 "bullet" is a value of the "list" format, not a format of its own (it logged an error).
    'list',
    'color', 'background',
    'link'
  ];

  useEffect(() => {
    let observer: MutationObserver | null = null;

    const id = window.setTimeout(() => {
      const quill = quillRef.current?.getEditor();
      if (!quill) return;

      const container = quill.root.parentElement as HTMLElement | null;
      if (!container) return;

      const tooltip = container.querySelector<HTMLElement>('.ql-tooltip');
      if (!tooltip) return;

      let wasHidden = true;

      const clamp = () => {
        if (tooltip.classList.contains('ql-hidden')) return;
        const rect = tooltip.getBoundingClientRect();
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const margin = 8;

        const currentTop = parseFloat(tooltip.style.top || '0');
        if (rect.bottom > vh - margin) {
          tooltip.style.top = `${currentTop - (rect.bottom - (vh - margin))}px`;
        } else if (rect.top < margin) {
          tooltip.style.top = `${currentTop + (margin - rect.top)}px`;
        }

        const currentLeft = parseFloat(tooltip.style.left || '0');
        if (rect.right > vw - margin) {
          tooltip.style.left = `${currentLeft - (rect.right - (vw - margin))}px`;
        } else if (rect.left < margin) {
          tooltip.style.left = `${currentLeft + (margin - rect.left)}px`;
        }
      };

      observer = new MutationObserver(() => {
        const isHidden = tooltip.classList.contains('ql-hidden');
        if (wasHidden && !isHidden) {
          requestAnimationFrame(clamp);
        }
        wasHidden = isHidden;
      });

      observer.observe(tooltip, { attributes: true, attributeFilter: ['class', 'style'] });
    }, 0);

    return () => {
      clearTimeout(id);
      observer?.disconnect();
    };
  }, []);

  const defaultPlaceholders = PLACEHOLDER_CHIPS;
  const allPlaceholders = [...new Set([...defaultPlaceholders, ...availablePlaceholders])].slice(0, 8);

  const handleInsertPlaceholder = (col: string) => {
    const placeholder = `{${col}}`;
    if (onInsertPlaceholder) {
      onInsertPlaceholder(placeholder);
    } else {
      const quill = quillRef.current?.getEditor();
      if (!quill) {
        onChange(value + placeholder);
        return;
      }
      const selection = quill.getSelection(true);
      const insertIndex = selection ? selection.index : quill.getLength();
      quill.insertText(insertIndex, placeholder, 'user');
      quill.setSelection(insertIndex + placeholder.length, 0, 'silent');
      onChange(quill.root.innerHTML);
      quill.focus();
    }
  };

  return (
    <div className="rich-text-editor">
      <div className="flex items-center justify-between mb-1.5">
        <label className="block text-sm font-medium text-gray-700">
          Body<span className="text-red-500 ml-0.5">*</span>
        </label>
        <div className="flex gap-1 flex-wrap justify-end">
          {allPlaceholders.map((col) => (
            <button
              key={col}
              type="button"
              onClick={() => handleInsertPlaceholder(col)}
              className="px-2 py-0.5 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition-colors font-mono"
            >
              {`{${col}}`}
            </button>
          ))}
        </div>
      </div>
      
      <div className={`border rounded-lg overflow-hidden ${error ? 'border-red-500' : 'border-gray-300'}`}>
        <ReactQuill
          ref={quillRef}
          theme="snow"
          value={value}
          onChange={onChange}
          modules={modules}
          formats={formats}
          placeholder={placeholder}
          className="bg-white"
        />
      </div>
      
      {error && (
        <p className="mt-1 text-sm text-red-500">{error}</p>
      )}
      
      <p className="text-xs text-gray-500 mt-1">
        Use placeholders like <code className="bg-gray-100 px-1 rounded">{'{first_name}'}</code> for personalization. Use the toolbar for headings, bold, lists, and links.
        To send raw HTML, choose the <strong>Custom HTML</strong> template instead.
      </p>

      <style>{`
        .rich-text-editor .ql-container {
          min-height: 200px;
          font-size: 14px;
        }
        .rich-text-editor .ql-editor {
          min-height: 200px;
        }
        .rich-text-editor .ql-toolbar {
          border-bottom: 1px solid #e5e7eb;
          background: #f9fafb;
        }
        .rich-text-editor .ql-container {
          border: none;
        }
        .rich-text-editor .ql-toolbar.ql-snow {
          border: none;
          border-bottom: 1px solid #e5e7eb;
        }
      `}</style>
    </div>
  );
}
