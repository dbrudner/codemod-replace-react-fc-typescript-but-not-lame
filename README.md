# codemod-replace-react-fc-typescript

A codemod using [jscodeshift](https://github.com/facebook/jscodeshift) to remove `React.FC` and `React.SFC` from your codebase, while properly handling children props.

## :man_teacher: Motivation

If you use React and Typescript, you might have come across this [GitHub PR in Create React App's repo](https://github.com/facebook/create-react-app/pull/8177) about removing `React.FC` from their base template of a Typescript project.

The three main points that made me buy this was the fact that:
- There's an implicit definition of `children` - all your components will have `children` typed!
- They don't support generics
- It does not correctly work with `defaultProps`

This codemod removes `React.FC`, `React.FunctionComponent` and `React.SFC` and replaces them with explicit prop types, while properly handling the children prop by adding `children?: ReactNode` where needed.

Let's see it with code:

```tsx
// before codemod runs
type Props = { title: string };
export const MyComponent: React.FC<Props> = ({ title, children }) => {
  return <div>{title}{children}</div>
}

// after codemod runs
type Props = { title: string };
export const MyComponent = ({ title, children }: Props & { children?: ReactNode }) => {
  return <div>{title}{children}</div>
}
```

It also works with inline props:

```tsx
// before codemod runs
export const MyComponent: React.FC<{ title: string }> = ({ title, children }) => <div>{title}{children}</div>

// after codemod runs
export const MyComponent = ({ title, children }: { title: string, children?: ReactNode }) => <div>{title}{children}</div>
```

And with no props, just children:

```tsx
// before codemod runs
const NoPropsComponent: React.FC = ({ children }) => <div>{children}</div>

// after codemod runs
const NoPropsComponent = ({ children }: { children?: ReactNode }) => <div>{children}</div>
```

## :toolbox: How to use

Run the following command:

```
npx jscodeshift -- -t https://raw.githubusercontent.com/dbrudner/codemod-replace-react-fc-typescript-with-children/main/dist/index.js --extensions=tsx --verbose=2 <FOLDER-YOU-WANT-TO-TRANSFORM>
```

## :notebook: Notes

- The codemod automatically adds the `children?: ReactNode` type when children are used in the component
- It will automatically add the ReactNode import from 'react' when needed
- The codemod focuses on replacing the nodes but does not do styling. You might want to run Prettier or your favorite formatting tool after the code has been modified.
