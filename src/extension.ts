
/*  MODULE OVERVIEW: 

    This is the main module used by VSCode as the entry point for the extension. It's main role
    is to:
    - handle VSCode events 
    - find and extract einsum / einops equations
    - set the decorations in the editor
    - check if cursor is near and equation to automatically turn on/off all decorations

    This module uses two submodules:
    - equation.ts : to digest an extracted equation returning all the terms with their position,
                    color and state
    - config.ts   : a class to bridge from the extension settings to properties. Also creates 
                    all the decoration types.

    For simplicity this extensions does not hold any state while switching between editors. This
    means any editor switch requires a [ FullUpdate ] to recreate the current state. As this is 
    not a frequent event and the [ FullUpdate ] was optimized for speed, this does not seem to 
    be a big cost for simplicity.


    CACHING - FULL/LINE SETS:

    <rant>
    VSCode has strange API implementation of setting decorations which requires nontrivial 
    solutions. The main problem is that when setting a decoration (e.g. red text color) using
    vscode.TextEditor.setDecorations you have to supply every range that it has to be applied to 
    (even the previously set ranges). Adding/removing even just one decoration range means you 
    have to supply all of them in the call.

    This means you have to have some kind of cache and manually keep it synchronized with the 
    actual state (there is no function to retrieve the current ranges). For example adding
    a new line invalidates all the cached ranges after the line and has to be taken into account. 

    VSCode API documentation does not have clear description of e.g. when onDidChangeTextDocument
    is called and with what info (e.g. surprisingly ctrl-s triggers this event but with 0 change 
    array). Because of this it seems almost impossible to have a fool-proof cache synchronized 
    with the actual state.
    </rant>

    One popular approach is to simply have no cache and do a full document update on every change 
    (with some throttling to not get overwhelmed).

    Here we use a simple observation: most of the editing done to a file is typing in a specific
    line and does not change or disturb other lines. So most of the cache will still be valid. 
    
    Once enter is pressed or there is some multiline operation (like copy pasting) it's hard to 
    follow the changes and the cache will have to be fully updated.


    To implement this we have two separate sets of decorations (styles) and the corresponding 
    ranges. One for the "Full" file and one for our edited "Line". 
    
    Normally the full document is searched for equations and all found term ranges are put in 
    the "Full" set. This happens e.g. as the initial scan when switching editors. Also any time 
    we have a multiline edit we fall back to just doing a Full update.
    
    But if the user starts typing in a single line we:
    - initially
        - (optionally merge previously edited "Line" set in the "Full" set)
        - remove this line decorations from the "Full" set
    - from there on, search only this one line for equation and use the "Line" set to manage
      decorations.
      
    This way we can independently handle just the edited line supplying only that line ranges to
    vscode.TextEditor.setDecorations.

    Side note: you can have multiple one-line edits e.g. when you alt-shift or ctrl-d resulting 
    in multiple cursors edits. But if every edit is a single line edit it can be handled just as
    one single line edit. Because of this the "Line" set can have multiple one-lines in it. The
    CurrentEditedLines array holds which lines are edited.

    A Full/Line set is 2D array: for each color in palette (default = 8) X for each state a term
    can be in.
*/



import * as vscode from 'vscode';
import * as eq from './equation';
import * as cfg from './config';

// this method is called when vs code is activated
export function activate(context: vscode.ExtensionContext) {
	
    //=== DEBUG LOGGING ===//
    let Log:vscode.OutputChannel;
    if (process.env.VSCODE_DEBUG_MODE === "true"){
        Log = vscode.window.createOutputChannel("Ein Color");
        Log.appendLine("LOG INIT");
        Log.show();
    }
    
    //=== SETTINGS ===//
    let Cfg = new cfg.Config(); 

    //=== VARIABLES ===//
    let DecorationsFull:vscode.TextEditorDecorationType[][];
    let DecorationsLine:vscode.TextEditorDecorationType[][];

    //=== "CURRENT STATE" VARIABLES ===//
    let DecorationsFullRanges:vscode.Range [][][];
    let DecorationsLineRanges:vscode.Range [][][];
    
    let IsDirty           = true;
    let DecorationsAreOn  = false;
    let CurrentEditedLines:number[] = [];
   
    let ActiveEditor:vscode.TextEditor|undefined;
   
    //=== INIT ===//
    ActiveEditor = vscode.window.activeTextEditor;
    Init();

    

    
    ///=== EVENTS ===///
    context.subscriptions.push (
        ///=== FREQUENT EVENTS ===///
        vscode.workspace.onDidChangeTextDocument    (OnTextChange),
        vscode.window.onDidChangeTextEditorSelection(OnCursorChange),

        ///=== RARE EVENTS ===///
        vscode.workspace.onDidChangeConfiguration   (OnConfigurationChange),
        vscode.window.onDidChangeActiveTextEditor   (OnActiveEditorChange),
        vscode.window.onDidChangeActiveColorTheme   (OnChangeTheme)
    );

    function OnConfigurationChange(event:vscode.ConfigurationChangeEvent){
        if (!event.affectsConfiguration('eincolor')) { return; };

        Log?.append("EVENT: on CFG change\n");
        Init();
    }

    function OnChangeTheme(){
        Log?.append("EVENT: on THEME change\n");

        //>> [1]: EXIT IF USING CUSTOM PALETTE INSTEAD OF DEFAULT LIGHT DARK
        if (Cfg.UsesCustomPalette) {return;};

        //>> [2]: IF THERE ARE DECORATIONS THEN REMOVE THEM
        if (DecorationsFull !== undefined){
            for (const stateDecor of DecorationsFull){
            for (const decor of stateDecor){ 
                    decor.dispose(); 
            }}
        }
        
        if (DecorationsLine !== undefined){
            for (const stateDecor of DecorationsLine){
            for (const decor of stateDecor){
                decor.dispose();
            }} 
        }
        
        //>> [3]: CREATE NEW DECORATIONS, SEPARATE FOR FULL AND LINES AND DO FULL UPDATE
        DecorationsFull = Cfg.CreateDecorations();
        DecorationsLine = Cfg.CreateDecorations();

        FullUpdate();
    }

    function OnActiveEditorChange(editor:vscode.TextEditor|undefined){
        Log?.append("EVENT: active EDITOR change (file: " + editor?.document.fileName + ")\n");


        //>> [1]: CHECK IF EDITOR IS VALID AND IF FILE NAME IS INCLUDED (CONFIG)
        if (!editor || (editor && !Cfg.IsDocumentIncluded(editor.document))){
            Log?.append("- no editor or included file:\n");
            ActiveEditor = undefined;
            return;
        }

        //>> [2]: RECREATE CURRENT STATE WITH FULL UPDATE
        ActiveEditor = editor; 

        FullUpdate();
    }

    function OnCursorChange(event:vscode.TextEditorSelectionChangeEvent){
        if (!ActiveEditor || event.textEditor !== ActiveEditor){return;}

        //>> [1]: RETURN IF DECORATIONS SHOULD BE ALWAYS ON
        if (Cfg.AlwaysOn){return;}
        

        let nearEquation = IsCursorNearEquation();
        
        //>> [2]: IF CURSOR NOT NEAR EQUATIONS THEN TURN OFF ALL DECORATIONS
        if (!nearEquation){
            if (!DecorationsAreOn){return;}

            Log?.append("TURN OFF\n");
            SetDecorations(DecorationsLine, null);    
            SetDecorations(DecorationsFull, null);
            DecorationsAreOn = false;
        }
        //>> [3]: ELSE
        else{
            //>> [3.1]: IF THERE WERE ANY CHANGES WHILE TURNED OFF THEN DO A FULL UPDATE
            if (IsDirty){
                Log?.append("TURN ON - DIRTY\n");
                DecorationsAreOn = true;
                FullUpdate();
            }
            //>> [3.2]: ELSE TURN ON THE PREVIOUS DECORATIONS
            else{
                if (DecorationsAreOn){return;}

                Log?.append("TURN ON - NORMAL\n");
                SetDecorations(DecorationsLine, DecorationsLineRanges);    
                SetDecorations(DecorationsFull, DecorationsFullRanges);
                DecorationsAreOn = true;   
            }
        }
    }

    function OnTextChange (event:vscode.TextDocumentChangeEvent) {
        if (!ActiveEditor || event.document !== ActiveEditor.document){
            return;}
        
        const startTime = performance.now();

        //>> [1]: IF NO CHANGES (?? like ctrl-s ??) THEN RETURN 
        if (event.contentChanges.length === 0){return;}
        

        //>> [2]: IF DECORATIONS SHOULD NOT SHOW UP THEN JUST MARK DIRTY AND RETURN 
        if (!Cfg.AlwaysOn && !DecorationsAreOn){
            IsDirty = true;
            return;
        }

        //>> [3]: GATHER NEW CURRENT LINES AND IF CHANGES ARE SINGLE LINED
        let allSingleLines = true;
        let numberOfLines: number[] = [];
        let lineIDs:number[] = [];

        for (const change of event.contentChanges) {
            let lines = change.text.split(/\r\n|\r|\n/).length;
            numberOfLines.push(lines);

            if (!change.range.isSingleLine || lines > 1){
                allSingleLines = false;
            }
            lineIDs.push(change.range.start.line + lines-1);
        }



        //>> [4]: IF NOT SINGLE LINES CHANGE THEN DO FULL UPDATE AND EXIT
        if (!allSingleLines){
            FullUpdate();
            return;
        }

        //>> [5]: IF MOVING TO NEW LINES
        if (CurrentEditedLines.length !== lineIDs.length ||
            CurrentEditedLines.some((v, i) => v !== lineIDs[i])){

            let added = false;
            let removed = false;

            //>> [5.1]: FOR EACH FULL DECORATIONS RANGE 
            for (let state = 0; state < eq.eTermState.COUNT; state++){ 
            for (let color = 0; color < Cfg.ColorCount; color++){

                //>> [5.1.1]: MERGE IN PREVIOUS LINE DECORATIONS
                let ranges = DecorationsFullRanges[state][color];
                if (DecorationsLineRanges[state][color].length !== 0){
                    ranges.push(...DecorationsLineRanges[state][color]);  
                    added = true;  
                } 
                
                //>> [5.1.2]: IF EVEN AFTER THAT THERE ARE NO RANGES THEN SKIP
                if (ranges.length === 0){continue;}

                //>> [5.1.3]: REMOVE NEW LINE DECORATIONS (SO WE CAN DECORATE THEM SEPARATELY)
                let newRanges = ranges.filter((r) => !lineIDs.includes(r.start.line)); 

                if (newRanges.length < ranges.length){
                    DecorationsFullRanges[state][color] = newRanges;
                    removed = true;
                }
            }}

            //>> [5.2]: IF ANY RANGE WAS REMOVED OR ADDED THEN UPDATE FULL DECORATIONS
            if (added || removed){
                Log?.append("MERGE/REMOVED\n");
                SetDecorations(DecorationsFull, DecorationsFullRanges);
            }


            //>> [5.3]: MOVE TO NEW LINES
            Log?.append("MOVING TO NEW LINES: " + lineIDs.map((n)=>n+1).toString() + '\n');
            CurrentEditedLines = lineIDs;
        }
        


        //>> [6]: FOR ALL LINES GATHER TERMS
        ClearDecorationRanges(DecorationsLineRanges); 
        for (const lineID of lineIDs) {
            let line = ActiveEditor.document.lineAt(lineID);
            let terms = GetLineTerms(line);

            if (terms){
                terms.forEach((term, i) => {
                    let range = new vscode.Range(lineID, term.Start,
                                                 lineID, term.Start + term.Text.length);  
                    DecorationsLineRanges[term.State][term.Color].push(range);
                });
            }       
        }
       
        //>> [7]: SET NEW LINE DECORATIONS
        SetDecorations(DecorationsLine, DecorationsLineRanges); 

        const endTime = performance.now();
        Log?.append(`line update: ${(endTime - startTime).toFixed(2)} milliseconds\n`);
    };


    

    


    //=== METHODS ===//
    function Init(){
    
        //>> [1]: READ CONFIGURATION
        Cfg.Update();

        //>> [2]: SET SEED FOR HASHING
        eq.Term.SEED = Cfg.HashSeed;

        //>> [3]: IF THERE ARE DECORATIONS THEN REMOVE THEM
        if (DecorationsFull !== undefined){
            for (const stateDecor of DecorationsFull){
            for (const decor of stateDecor){ 
                    decor.dispose(); 
            }}
        }
        
        if (DecorationsLine !== undefined){
            for (const stateDecor of DecorationsLine){
            for (const decor of stateDecor){
                decor.dispose();
            }} 
        }
        
        //>> [4]: CREATE NEW DECORATIONS,SEPARATE FOR FULL AND LINES
        DecorationsFull = Cfg.CreateDecorations();
        DecorationsLine = Cfg.CreateDecorations();
        
        //>> [5]: CREATE DECORATION RANGES THAT WILL FIT COLOR COUNT
        DecorationsFullRanges = Array.from({length:eq.eTermState.COUNT}, () => Array.from({length:Cfg.ColorCount},()=>[]));
        DecorationsLineRanges = Array.from({length:eq.eTermState.COUNT}, () => Array.from({length:Cfg.ColorCount},()=>[]));

        //>> [6]: RECREATE CURRENT STATE WITH FULL UPDATE
        FullUpdate();   
    }

    function FullUpdate(){
        if (!ActiveEditor){return;}

        const startTime = performance.now();

        //>> [1]: CANCEL EDITING CURRENT LINES AND REMOVE LINE DECORATORS
        ClearDecorationRanges(DecorationsLineRanges);
        CurrentEditedLines = [];
        SetDecorations(DecorationsLine, null);
        

        //>> [2]: SEARCH ALL LINES FOR TERMS  
        ClearDecorationRanges(DecorationsFullRanges);
        for (let lineID = 0; lineID < ActiveEditor.document.lineCount; lineID++) {
            
            let line = ActiveEditor.document.lineAt(lineID);
            
            let terms = GetLineTerms(line);
            if (!terms){continue;}
            
            terms.forEach((term, i) => {
                let range = new vscode.Range(lineID, term.Start,
                                             lineID, term.Start + term.Text.length);  
                DecorationsFullRanges[term.State][term.Color].push(range);
            });    
        }
   
        //wait(1000);

        //>> [3]: UPDATE IF CURSOR IS NEAR EQUATION AND SET DECORATIONS IF THEY SHOULD SHOW UP
        DecorationsAreOn = IsCursorNearEquation();

        if (Cfg.AlwaysOn || DecorationsAreOn){
            SetDecorations(DecorationsFull, DecorationsFullRanges);
        }
        else {
            SetDecorations(DecorationsFull, null);
        }
    

        //>> [4]: MARK DECORATORS STATE AS NOT DIRTY
        IsDirty = false;

        const endTime = performance.now();
        Log?.append(`FULL UPDATE: ${(endTime - startTime).toFixed(2)} milliseconds\n`);
    }

    function GetLineTerms(Line:vscode.TextLine): eq.Term[]|null {

        //>> [1]: FIND IF AND WHERE IS THE EQUATION (EXIT IF NONE FOUND)
        let text = Line.text; 
        let [start, end] = FindLineEquation(Line);

        if (start === -1){return null;}


        //>> [2]: EXTRACT AND RETURN TERMS IN THE EQUATION
        let equation = text.substring(start, end === -1 ? undefined :  end); 
        return eq.DigestEquation(equation, eq.eEquationType.AutoSpaces, start, Cfg.ColorCount, Cfg.Coloring);
    }

    function FindLineEquation(Line:vscode.TextLine): [number,number]{

        let text = Line.text; 

        //>> [1]: SKIP EMPTY LINE
        if (Line.isEmptyOrWhitespace){return [-1,-1];}

        //>> [2]: TRY TO FIND ANY OF THE EINSUM/EINOPS PREFIXES
        let start = -1;

        let prefix = Cfg.SearchForPrefix(text);
        if (prefix){
            start = prefix.index + prefix[0].length;
        };

        if (start === -1){return [-1,-1];}


        //>> [3]: IF THE EQUATION APPEARS AFTER A PARAMETER NAME TRY TO FIND '/" AFTER THAT (^)
        let quotemark:RegExpExecArray|null;
        let namedParam = /(equation|pattern|subscripts)\s*=/.exec(text.substring(start));
        if (namedParam) {
            start += namedParam.index + namedParam[0].length; 
            
            quotemark = /^\s*["']/.exec(text.substring(start));   
        }
        //>> [4]: ELSE TRY TO FIND '/" AT START (^) OR AFTER A , (/s* -SKIP ANY SPACES)
        else{
            quotemark = /(^|,)\s*["']/.exec(text.substring(start));
        }

        if (!quotemark) {return [-1,-1];}
        start += quotemark.index + quotemark[0].length;        


        //>> [5]: FIND CLOSING '/" OR ACCEPT END OF LINE
        let end = text.substring(start).search(/["']/);
        if (end !== -1) {end += start;};


        //>> [6]: RETURN FOUND EQUATION RANGE
        return [start, end];
    }

    function SetDecorations(Decorations:vscode.TextEditorDecorationType[][], 
                            Ranges     :vscode.Range [][][]|null){

        //>> [1]: SET DECORATIONS FOR CURRENT EDITOR
        if (!ActiveEditor){return;}

        for (let state = 0; state < eq.eTermState.COUNT; state++){ 
        for (let color = 0; color < Cfg.ColorCount; color++){ 
            ActiveEditor.setDecorations(Decorations[state][color], Ranges ? Ranges[state][color] : []);
        }}
        
    }

    function ClearDecorationRanges(DecorationRanges:vscode.Range [][][]){
        for (let state = 0; state < eq.eTermState.COUNT; state++){
        for (let color = 0; color < Cfg.ColorCount; color++){
            DecorationRanges[state][color] = []; 
        }}  
    }  

    function IsCursorNearEquation(): boolean{
        if (!ActiveEditor){return false;}

        //>> [1]: USE CURSOR ANCHOR POINT (SO IT'S NOT MOVING WHEN SELECTING MULTIPLE LINES)
        let cursorLine = ActiveEditor.selection.anchor.line;
        let foundEquation = false;

        //>> [2]: TRY TO FIND AN EQUATION ON AND AROUND THE CURSOR ANCHOR POINT
        for (let line = cursorLine-Cfg.NearCursor; line <= cursorLine+Cfg.NearCursor; line++) {

            let clampedLine = Math.min(Math.max(line, 0), ActiveEditor.document.lineCount-1);

            let [start, end] = FindLineEquation(ActiveEditor.document.lineAt(clampedLine));

            if (start !== -1){
                foundEquation = true;
                break;
            }
        }

        //>> [3]: RETURN IF FOUND ANY EQUATION
        return foundEquation;
    }

}
