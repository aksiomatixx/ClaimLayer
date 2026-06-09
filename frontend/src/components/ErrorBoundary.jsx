import { Component } from 'react';
import { C } from '../theme.js';

/**
 * Top-level error boundary — catches render/lifecycle errors anywhere in
 * the tree and shows a recoverable fallback instead of a blank page.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Unhandled render error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{minHeight:'100vh',background:C.bg,color:C.text,fontFamily:C.sans,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:'28px 32px',maxWidth:520,textAlign:'center'}}>
          <div style={{fontSize:28,marginBottom:12}}>⚠️</div>
          <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Something went wrong</div>
          <div style={{fontSize:12,color:C.dim,fontFamily:C.mono,marginBottom:18,wordBreak:'break-word'}}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{background:C.amber,color:'#000',border:'none',padding:'10px 22px',borderRadius:7,fontSize:13,fontWeight:700,fontFamily:C.sans,cursor:'pointer'}}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
