/*
- function signatures and declarations
- method signatures and definitions
- abstract method signatures
- class declarations (including abstract classes)
- module declarations
*/

// Query for finding imports
export const importQuery = `
[
  ; Regular named imports
  (import_statement 
    source: (string (string_fragment) @module)
    (import_clause 
      (named_imports 
        (import_specifier 
          name: (identifier) @import))))
  
  ; Type-only imports
  (import_statement
    source: (string (string_fragment) @module)
    (import_clause
      "type"
      (named_imports
        (import_specifier
          name: (identifier) @import))))
  
  ; Namespace imports
  (import_statement
    source: (string (string_fragment) @module)
    (import_clause
      (namespace_import
        name: (identifier) @import)))
  
  ; Re-exports
  (export_statement
    source: (string (string_fragment) @module)
    (export_clause
      (export_specifier
        name: (identifier) @import)))
  
  ; Type-only re-exports
  (export_statement
    "type"
    source: (string (string_fragment) @module)
    (export_clause
      (export_specifier
        name: (identifier) @import)))
]
`

// Query for finding definitions
export default `
(function_signature
  name: (identifier) @name.definition.function) @definition.function

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(module
  name: (identifier) @name.definition.module) @definition.module

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class
`
