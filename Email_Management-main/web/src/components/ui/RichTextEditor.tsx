import React, { useMemo } from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';

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
  const modules = useMemo(() => ({
    toolbar: [
      ['bold', 'italic', 'underline'],
      [{ 'list': 'bullet' }, { 'list': 'ordered' }],
      [{ 'color': [] }, { 'background': [] }],
      ['link'],
      ['clean']
    ],
  }), []);

  const formats = [
    'bold', 'italic', 'underline',
    'list', 'bullet',
    'color', 'background',
    'link'
  ];

  const defaultPlaceholders = ['email', 'first_name', 'last_name', 'company'];
  const allPlaceholders = [...new Set([...defaultPlaceholders, ...availablePlaceholders])].slice(0, 8);

  const handleInsertPlaceholder = (col: string) => {
    const placeholder = `{${col}}`;
    if (onInsertPlaceholder) {
      onInsertPlaceholder(placeholder);
    } else {
      onChange(value + placeholder);
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
      
      <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
        <span>ℹ</span> Use placeholders like {'{first_name}'} for personalization. Select text and use the toolbar for formatting.
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
