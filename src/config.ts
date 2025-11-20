
/*  MODULE OVERVIEW: 

    This module contains the Config class - a bridge between the extension an it's configuration 
    in VSCode settings. 
    
    Config is a "passive" class that only changes it's internal state and does not automatically 
    change the state of the extension. This has to be handled by the parent extension.ts through
    it's methods. 
    
    E.g. the HashSeed has to be manually read from the Config by the extension and set in the 
    equation.Term class. 

    [ Update ] translates all of the settings into properties. It's called by [ Init ] in
    extension.ts triggered at extensions start and  onDidChangeConfiguration event. All 
    validation is made here.
    
    [ CreateDecorations ] is called to create full decorations (colors x states) based on the 
    settings.
    
    [ IsDocumentIncluded ] simply check if the file fits the include filter in the settings.

    [ SearchForPrefix ] wrapper function for the prefix RegEx to search through Text

    Lastly there are the definitions of the default Light and Dark palettes.
*/



import * as vscode from 'vscode';
import * as eq from './equation';

export class Config{

    private _AlwaysOn:boolean = false;
    private _NearCursor:number = 1;
      
    private _Coloring = eq.eColoring.SemiHashed;
    private _HashSeed:number = 0;
    private PrefixRegEx:RegExp = RegExp('');
    
    private IncludedFiles:string = "{*.*}";
    private _UsesCustomPalette:boolean = false;
    private CustomPalette:string[] = [];
    private UseBoldTerms:boolean = false;

    get AlwaysOn  (): boolean           { return this._AlwaysOn;       }
    get NearCursor(): number            { return this._NearCursor;     }
    get ColorCount(): number            { if (this._UsesCustomPalette) {return this.CustomPalette.length;} 
                                          else                         {return this.DarkPalette.length;}}
    get Coloring  (): eq.eColoring      { return this._Coloring;       }
    get HashSeed  (): number            { return this._HashSeed;       }

    get UsesCustomPalette(): boolean    { return this._UsesCustomPalette;    }  

    Update(){
        let cfg = vscode.workspace.getConfiguration('eincolor');

        this._AlwaysOn   = cfg.Mode === "Always On";
        this._NearCursor = cfg.CursorNearRange;

        switch (cfg.Coloring) {
            case "Hashed"     : this._Coloring = eq.eColoring.Hashed;     break;
            case "Semi Hashed": this._Coloring = eq.eColoring.SemiHashed; break;
            case "Ordered"    : this._Coloring = eq.eColoring.Ordered;    break;
            default           : this._Coloring = eq.eColoring.SemiHashed; break;
        }

        this._HashSeed = cfg.HashSeed;

        if (cfg.IncludedFiles.length === 0) {this.IncludedFiles = "{**/*.*}";}
        else                                {this.IncludedFiles = "{" + cfg.IncludedFiles.join(',') + "}";}

        this._UsesCustomPalette = cfg.UseCustomColorPalette;
        
        this.CustomPalette = cfg.CustomColorPalette;
        if (this.CustomPalette.length === 0) {this._UsesCustomPalette = false;};

        this.UseBoldTerms = cfg.UseBoldTerms;


        //>> CHECK ALL PREFIX REGEX AND GATHER ONLY VALID ONES (SHOW ERROR MESSAGE FOR EACH ERROR)
        let validPrefix:string[] = [];

        for (const prefix of cfg.EquationPrefix) {
            try{
                RegExp(prefix);
                validPrefix.push(prefix);
            }
            catch(error:any){
                vscode.window.showErrorMessage(
                    `${error.message}`,"Open Settings"
                    
                ).then(selection => {
                    if (selection === "Open Settings") {
                        vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'eincolor.EquationPrefix'
                        );
                    };
                });
            }       
        }

        let prefixes = validPrefix.join('\\s*\\(|');
        if (validPrefix.length > 0){
            prefixes = prefixes + '\\s*\\(';
        };
        this.PrefixRegEx = RegExp(prefixes);
    }

    CreateDecorations():vscode.TextEditorDecorationType[][]{

        let isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;

        let decorations:vscode.TextEditorDecorationType[][];
        decorations = Array.from({length:eq.eTermState.COUNT}, () =>[]);

        //>> [1]: CREATE ALL STATE STYLES 
        let useBold    = this.UseBoldTerms ? "bold" : "";

        let normal  = { fontWeight     : useBold};
        
        let removed = { textDecoration : `line-through`,
                        fontStyle      : "italic",
                        fontWeight     : useBold};

        let added   = { fontStyle      : "italic",
                        fontWeight     : useBold};

        let inall   = { textDecoration : "underline",
                        fontWeight     : useBold};

                        
        //>> [2]: FOR EACH COLOR
        for (let i = 0; i < this.ColorCount; i++) {

            //>> [2.1]: CREATE COLOR STYLE (CUSTOM OR DEFAULT PALETTE)
            let colorString:string;
            if (this._UsesCustomPalette) {colorString = this.CustomPalette[i];}
            else                         {colorString = isDark ? this.DarkPalette[i]:this.LightPalette[i];}
            
            let color    = { color: colorString};
            let colorDim = { color: `lch(from ${colorString} calc(l*${isDark ? 0.7 : 0.8}) c h)`};
        
            //>> [2.2]: APPEND COLOR TO THE LINE THROUGH IN REMOVED STYLE
            let removedCol = {...removed};
            removedCol.textDecoration += ` lch(from ${colorString} calc(l*${isDark ? 1.1 : 1.25}) c h)`;

            //>> [2.3]: COMBINE COLOR AND STATES TO CREATE DECORATIONS
            decorations[eq.eTermState.Normal ].push(vscode.window.createTextEditorDecorationType({...color   ,...normal    }));
            decorations[eq.eTermState.Reduced].push(vscode.window.createTextEditorDecorationType({...colorDim,...removedCol}));
            decorations[eq.eTermState.New    ].push(vscode.window.createTextEditorDecorationType({...color   ,...added     }));
            decorations[eq.eTermState.InAll  ].push(vscode.window.createTextEditorDecorationType({...color   ,...inall     }));
        }  

        //>> [3]: RETURN ALL DECORATIONS
        return decorations;
    }

    IsDocumentIncluded(Document:vscode.TextDocument): boolean{
        let filter: vscode.DocumentFilter = { pattern: this.IncludedFiles};
        return vscode.languages.match(filter, Document) !== 0;
    }

    SearchForPrefix(Text:string): RegExpExecArray|null{

        return this.PrefixRegEx.exec(Text);
    }

    ///=== DEFAULT PALETTES ===///

    private DarkPalette: string[] = [
                                  "lch(69% 60 30 )",
                                  "lch(71% 60 260)",
                                  "lch(78% 60 69 )",
                                  "lch(70% 60 303)",
                                  "lch(93% 80 120)",
                                  "lch(78% 60 334)",
                                  "lch(85% 60 196)",
                                  "lch(90% 60 90 )"]; 

    private LightPalette: string[] = [
                                  "lch(40% 90  30 )",
                                  "lch(40% 80  260)",
                                  "lch(48% 150 69 )",
                                  "lch(40% 80  303)",
                                  "lch(48% 90  120)",
                                  "lch(44% 85  334)",
                                  "lch(46% 99  196)",
                                  "lch(53% 80  90 )"]; 

}