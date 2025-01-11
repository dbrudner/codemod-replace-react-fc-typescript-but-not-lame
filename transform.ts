import {
  FileInfo,
  API,
  ArrowFunctionExpression,
  ASTPath,
  Identifier,
  VariableDeclarator,
  TSTypeReference,
  ObjectPattern,
  TSTypeLiteral,
  TSIntersectionType,
  TSTypeAnnotation,
  JSCodeshift,
  FunctionExpression,
  CallExpression,
} from 'jscodeshift'

export const parser = 'tsx'

const isIdentifier = (x: any): x is Identifier => (x as Identifier).type === 'Identifier'
const isTsTypeReference = (x: any): x is TSTypeReference => (x as TSTypeReference).type === 'TSTypeReference'
const isObjectPattern = (x: any): x is ObjectPattern => (x as ObjectPattern).type === 'ObjectPattern'
const isTsIntersectionType = (x: any): x is TSIntersectionType =>
  (x as TSIntersectionType).type === 'TSIntersectionType'
const isArrowFunctionExpression = (x: any): x is ArrowFunctionExpression =>
  (x as ArrowFunctionExpression).type === 'ArrowFunctionExpression'
// Using a function that accepts a component definition
const isCallExpression = (x: any): x is CallExpression => x?.type === 'CallExpression'
const isTSIntersectionType = (x: any): x is TSIntersectionType => x?.type === 'TSIntersectionType'

export default (fileInfo: FileInfo, { j }: API) => {
  function addPropsTypeToComponentBody(n: ASTPath<VariableDeclarator>, root: any, j: JSCodeshift) {
    // extract the Prop's type text
    let reactFcOrSfcNode
    if (isIdentifier(n.node.id)) {
      if (isTSIntersectionType(n.node.id.typeAnnotation!.typeAnnotation)) {
        reactFcOrSfcNode = n.node.id.typeAnnotation!.typeAnnotation.types[0] as TSTypeReference
      } else {
        reactFcOrSfcNode = n.node.id.typeAnnotation!.typeAnnotation as TSTypeReference
      }
    }

    const componentFunctionNode = (isCallExpression(n.node.init) ? n.node.init.arguments[0] : n.node.init) as
      | ArrowFunctionExpression
      | FunctionExpression

    // Get firstParam before we use it
    const firstParam = componentFunctionNode.params[0]

    // shape of React.FC (no props)
    if (!reactFcOrSfcNode?.typeParameters) {
      // If component is using React.FC without type params and has children, we should add the type
      if (firstParam && isObjectPattern(firstParam) && 
          firstParam.properties.some(p => 
            (p.type === 'Property' || p.type === 'ObjectProperty') && 
            ((p as any).key?.name === 'children' || (p as any).value?.name === 'children')
          )) {
        const childrenProp = j.tsPropertySignature(
          j.identifier('children'),
          j.tsTypeAnnotation(
            j.tsTypeReference(j.identifier('ReactNode'))
          )
        )
        childrenProp.optional = true

        const outerNewTypeAnnotation = j.tsTypeAnnotation(
          j.tsTypeLiteral([childrenProp])
        )

        // Add ReactNode import
        ensureReactNodeImport(j, root);

        // Update the parameter type
        if (isObjectPattern(firstParam)) {
          const { properties, ...restParams } = firstParam
          let componentFunctionFirstParameter = j.objectPattern.from({
            ...restParams,
            properties: properties.map(({ loc, ...rest }) => {
              const key = rest.type.slice(0, 1).toLowerCase() + rest.type.slice(1)
              if (key === 'restElement') {
                const prop = rest as any
                return j.restProperty.from({ argument: prop.argument })
              }
              return j[key].from({ ...rest })
            }),
            typeAnnotation: outerNewTypeAnnotation,
          })

          let newInit: ArrowFunctionExpression | FunctionExpression
          if (isArrowFunctionExpression(componentFunctionNode)) {
            newInit = j.arrowFunctionExpression.from({
              ...componentFunctionNode,
              params: [componentFunctionFirstParameter],
            })
          } else {
            newInit = j.functionExpression.from({
              ...componentFunctionNode,
              params: [componentFunctionFirstParameter],
            })
          }

          const newVariableDeclarator = j.variableDeclarator.from({ 
            ...n.node, 
            init: newInit 
          })
          n.replace(newVariableDeclarator)
        }
      }
      return
    }

    // Check if children is used in the parameters or body
    const usesChildren = firstParam && (
      // Check destructured children in params
      (isObjectPattern(firstParam) && 
        firstParam.properties.some(p => 
          (p.type === 'Property' || p.type === 'ObjectProperty') && 
          ((p as any).key?.name === 'children' || (p as any).value?.name === 'children')
        )
      ) ||
      // Check props.children usage in body
      (isIdentifier(firstParam) && 
        j(componentFunctionNode).find(j.MemberExpression, {
          object: { name: firstParam.name },
          property: { name: 'children' }
        }).length > 0
      ) ||
      // Check if children is used in JSX
      j(componentFunctionNode).find(j.JSXElement).some(path => 
        path.node.children.some((child: any) => 
          child.type === 'JSXExpressionContainer' && 
          child.expression.name === 'children'
        )
      ) ||
      // Check if the component is using React.FC without props (should add children)
      !reactFcOrSfcNode.typeParameters
    );

    // Only add ReactNode import if we're adding children type
    if (usesChildren) {
      ensureReactNodeImport(j, root);
    }

    // Only add children type if it's used
    const outerNewTypeAnnotation = extractPropsDefinitionFromReactFC(j, reactFcOrSfcNode, usesChildren)
    // build the new nodes
    const paramsLength = componentFunctionNode?.params?.length
    // The remaining parameters except the first parameter
    let restParameters = []
    if (!paramsLength) {
      // if no params, it could be that the component is not actually using props, so nothing to do here
      return
    } else {
      restParameters = componentFunctionNode.params.slice(1, paramsLength)
    }

    let componentFunctionFirstParameter: Identifier | ObjectPattern | undefined = undefined;

    // form of (props) =>
    if (isIdentifier(firstParam)) {
      componentFunctionFirstParameter = j.identifier.from({
        ...firstParam,
        typeAnnotation: outerNewTypeAnnotation!,
      })
    }

    // form of ({ foo }) =>
    if (isObjectPattern(firstParam)) {
      const { properties, ...restParams } = firstParam
      componentFunctionFirstParameter = j.objectPattern.from({
        ...restParams,
        // remove locations because properties might have a spread like ({ id, ...rest }) => and it breaks otherwise
        properties: properties.map(({ loc, ...rest }) => {
          const key = rest.type.slice(0, 1).toLowerCase() + rest.type.slice(1)
          // This workaround is because the AST parsed has "RestElement, but codeshift (as well as the types) expects "RestProperty"
          // manually doing this works ok. restElement has the properties needed
          if (key === 'restElement') {
            const prop = rest as any
            return j.restProperty.from({ argument: prop.argument })
          }
          return j[key].from({ ...rest })
        }),
        typeAnnotation: outerNewTypeAnnotation!,
      })
    }

    let newInit: ArrowFunctionExpression | FunctionExpression | undefined
    if (isArrowFunctionExpression(componentFunctionNode)) {
      newInit = j.arrowFunctionExpression.from({
        ...componentFunctionNode,
        params: [componentFunctionFirstParameter!, ...restParameters],
      })
    } else {
      newInit = j.functionExpression.from({
        ...componentFunctionNode,
        params: [componentFunctionFirstParameter!, ...restParameters],
      })
    }
    let newVariableDeclarator: VariableDeclarator
    if (isCallExpression(n.node.init)) {
      newVariableDeclarator = j.variableDeclarator.from({
        ...n.node,
        init: {
          ...n.node.init,
          arguments: [newInit],
        },
      })
    } else {
      newVariableDeclarator = j.variableDeclarator.from({ ...n.node, init: newInit })
    }

    n.replace(newVariableDeclarator)
    return
  }

  function removeReactFCorSFCdeclaration(n: ASTPath<VariableDeclarator>) {
    const { id, ...restOfNode } = n.node
    const { typeAnnotation, ...restOfId } = id as Identifier
    const newId = j.identifier.from({ ...restOfId })
    const newVariableDeclarator = j.variableDeclarator.from({
      ...restOfNode,
      id: newId,
    })
    n.replace(newVariableDeclarator)
  }

  function ensureReactNodeImport(j: JSCodeshift, root: any) {
    const reactImports = root.find(j.ImportDeclaration, {
      source: { value: 'react' }
    });
    
    if (reactImports.length === 0) return;

    const firstReactImport = reactImports.get(0);
    const existingSpecifiers = firstReactImport.node.specifiers;
    
    // Check if ReactNode is already imported
    const hasReactNode = existingSpecifiers.some((spec: any) => 
      spec.type === 'ImportSpecifier' && spec.imported.name === 'ReactNode'
    );

    if (!hasReactNode) {
      firstReactImport.node.specifiers = [
        ...existingSpecifiers,
        j.importSpecifier(j.identifier('ReactNode'))
      ];
    }
  }

  try {
    const root = j(fileInfo.source)
    let hasModifications = false
    root
      .find(j.VariableDeclarator, (n: any) => {
        const identifier = n?.id
        let typeName
        if (isTSIntersectionType(identifier?.typeAnnotation?.typeAnnotation)) {
          typeName = identifier.typeAnnotation.typeAnnotation.types[0].typeName
        } else {
          typeName = identifier?.typeAnnotation?.typeAnnotation?.typeName
        }

        const genericParamsType = identifier?.typeAnnotation?.typeAnnotation?.typeParameters?.type
        // verify it is the shape of React.FC<Props> React.SFC<Props>, React.FC<{ type: string }>, FC<Props>, SFC<Props>, and so on

        const isEqualFcOrFunctionComponent = (name: string) => ['FC', 'FunctionComponent'].includes(name)
        const isFC =
          (typeName?.left?.name === 'React' && isEqualFcOrFunctionComponent(typeName?.right?.name)) ||
          isEqualFcOrFunctionComponent(typeName?.name)
        const isSFC = (typeName?.left?.name === 'React' && typeName?.right?.name === 'SFC') || typeName?.name === 'SFC'

        return (
          (isFC || isSFC) &&
          (['TSQualifiedName', 'TSTypeParameterInstantiation'].includes(genericParamsType) ||
            !identifier?.typeAnnotation?.typeAnnotation?.typeParameters)
        )
      })
      .forEach((n) => {
        hasModifications = true
        addPropsTypeToComponentBody(n, root, j)
        removeReactFCorSFCdeclaration(n)
      })

    if (hasModifications) {
      return root.toSource()
    }
    return null
  } catch (e) {
    console.log(e)
  }
}

function extractPropsDefinitionFromReactFC(
  j: JSCodeshift, 
  reactFcOrSfcNode: TSTypeReference, 
  addChildren: boolean = false
): TSTypeAnnotation {
  const typeParameterFirstParam = reactFcOrSfcNode.typeParameters!.params[0]
  let newInnerTypeAnnotation: TSTypeReference | TSIntersectionType | TSTypeLiteral | undefined

  if (isTsTypeReference(typeParameterFirstParam)) {
    const { loc, ...rest } = typeParameterFirstParam
    if (addChildren) {
      const childrenProp = j.tsPropertySignature(
        j.identifier('children'),
        j.tsTypeAnnotation(
          j.tsTypeReference(j.identifier('ReactNode'))
        )
      )
      childrenProp.optional = true

      newInnerTypeAnnotation = j.tsIntersectionType([
        j.tsTypeReference.from({ ...rest }),
        j.tsTypeLiteral([childrenProp])
      ])
    } else {
      newInnerTypeAnnotation = j.tsTypeReference.from({ ...rest })
    }
  } else if (isTsIntersectionType(typeParameterFirstParam)) {
    // form of React.FC<Props & Props2>
    const { loc, ...rest } = typeParameterFirstParam
    if (addChildren) {
      const childrenProp = j.tsPropertySignature(
        j.identifier('children'),
        j.tsTypeAnnotation(
          j.tsTypeReference(j.identifier('ReactNode'))
        )
      )
      childrenProp.optional = true

      newInnerTypeAnnotation = j.tsIntersectionType([
        ...rest.types.map((t) => buildDynamicalNodeByType(j, t)),
        j.tsTypeLiteral([childrenProp])
      ])
    } else {
      newInnerTypeAnnotation = j.tsIntersectionType.from({
        ...rest,
        types: rest.types.map((t) => buildDynamicalNodeByType(j, t)),
      })
    }
  } else {
    // form of React.FC<{ foo: number }> or React.SFC<{ foo: number }>
    const inlineTypeDeclaration = typeParameterFirstParam as TSTypeLiteral
    if (addChildren) {
      const childrenProp = j.tsPropertySignature(
        j.identifier('children'),
        j.tsTypeAnnotation(
          j.tsTypeReference(j.identifier('ReactNode'))
        )
      )
      childrenProp.optional = true

      newInnerTypeAnnotation = j.tsTypeLiteral([
        ...inlineTypeDeclaration.members.map((m) => buildDynamicalNodeByType(j, m)),
        childrenProp
      ])
    } else {
      const newMembers = inlineTypeDeclaration.members.map((m) => buildDynamicalNodeByType(j, m))
      newInnerTypeAnnotation = j.tsTypeLiteral.from({ members: newMembers })
    }
  }

  return j.tsTypeAnnotation.from({ typeAnnotation: newInnerTypeAnnotation })
}

// dynamically call the api method to build the proper node. For example TSPropertySignature becomes tsPropertySignature
function buildDynamicalNodeByType(j: JSCodeshift, { loc, ...rest }: any) {
  const key = rest.type.slice(0, 2).toLowerCase() + rest.type.slice(2)
  return j[key].from({ ...rest })
}
