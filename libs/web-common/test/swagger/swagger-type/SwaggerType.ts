import { Type } from 'ts-morph';

function getType(type: Type): string | undefined {
  if (type.isArray()) {
    return getElementType(type);
  }

  const isGeneric = type.getTypeArguments()[0];

  if (isGeneric) {
    return getGenericType(type);
  }

  if (type.isBoolean()) {
    return Boolean.name;
  }

  if (type.isNumber()) {
    return Number.name;
  }

  if (type.isEnum() || type.isEnumLiteral()) {
    return undefined;
  }

  if (type.isString() || type.isStringLiteral()) {
    return String.name;
  }

  if (type.isUnion()) {
    const unionTypes = type.getUnionTypes();

    return getType(unionTypes[unionTypes.length - 1]);
  }

  if (type.isClassOrInterface()) {
    return getImportNameType(type.getText());
  }

  const text = type.getText();

  if (text === Date.name) {
    return text;
  }

  if (text === 'any' || text === 'unknown' || text === 'object') {
    return 'Object';
  }

  return undefined;
}

function getElementType(type: Type) {
  const arrayType = type.getArrayElementType();

  if (!arrayType) {
    return undefined;
  }

  return getType(arrayType);
}

function getGenericType(type: Type): string | undefined {
  const result = type.getTypeArguments()[0];

  if (type.getText().includes('ResponseEntity<string>')) {
    return 'ResponseEntity';
  }

  if (!result?.getText()) {
    return getType(type);
  }

  return getGenericType(result);
}

// import('...').ClassA 형태에서 named import인 ClassA 만 가져오도록 한다.
function getImportNameType(textType: string) {
  if (!textType.includes('import(')) {
    return textType;
  }

  return textType.split('.')[1];
}

function isOptionalType(type: Type): boolean {
  if (type.isUnion()) {
    const unionTypes = type.getUnionTypes();

    return unionTypes.some(
      (type) =>
        type.getText().includes('undefined') || type.getText().includes('null'),
    );
  }

  return type.isUndefined() || type.isNull();
}

function isPageType(type: Type): boolean {
  return type.getText().includes('Page<');
}

function isArrayType(type: Type): boolean {
  return type.isArray() || type.getText().includes('[]');
}

export {
  getType,
  getElementType,
  getGenericType,
  getImportNameType,
  isOptionalType,
  isPageType,
  isArrayType,
};
