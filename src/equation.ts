
/*  MODULE OVERVIEW: 

    This modules contains everything for digesting an equation and returning a list of 
    Terms with their range, color ID and state.

    [ DigestEquation ] is the main and only exported function. First it takes in a single 
    equation and extracts the terms [ ExtractTerms ] with their states (see eTermState).
    
    Then it determines each term color ID. The Ordered and Semi Hashed coloring are non trivial 
    so they were extracted to their own sub functions ([ ColorOrdered ], [ ColorSemiHashed ]).


    Equation type [ eEquationType ] is a hint as to what to expect from the equation and use the 
    appropriate RegEx. For auto the formula to determine if the are separating spaces is:
    - extract all arguments and results strings
    - check if any has spaces between terms
    - also check if there is an opening parenthesis ( meaning it's an einops equation that must
      have spaces (checking for a closing parenthesis may be problematic while typing - as there 
      could be autoinstereted closing of the function call)

    This formula could be too simplistic to catch all possible cases and could change in the 
    future.

    Currently only eEquationType.AutoSpaces is used by the extension.


    The [ GenerateHash ] function was found on the net. It's results will be modulo mapped on a 
    small number of colors so it doesn't have to be ideal. It can be simpler to be fast.
    But it should have significant spread for short strings like "a" vs "b".
*/



export enum eTermState {
    Normal = 0,     // the default state
    InAll,          // when a term is in all arguments and results (equations with 2+ arguments)
    Reduced,        // if the term does not show up in the result, meaning it got reduced
    New,            // when a term shows up only in the results (e.g. for einops.repeat)
    COUNT
}

export enum eEquationType {
    NoSpaces = 0,   // e.g. "ab->ba" (the classic notation)
    WithSpaces,     // e.g. "a b -> b a" or "width height -> height width" 
    AutoSpaces,     // determine which of the above
    COUNT
}

export enum eColoring {
    Hashed = 0,     // hash from term string used for color ID % color count
    SemiHashed,     // as above for non-colliding terms, fit rest in free colors
    Ordered,        // color ID determined by first term occurrence in equation
    COUNT
}


export class Term{
    Start:number;
    Text:string;
    Hash:number;

    State:eTermState;
    Color:number;

    static SEED:number = 0;
    
    constructor(Start:number, Text:string){
        this.Start = Start;
        this.Text  = Text;
        this.Hash  = GenerateHash(Text, Term.SEED);

        this.State = eTermState.Normal;
        this.Color = -1;
    };
}


export function DigestEquation(Equation:string, Type:eEquationType, Offset:number, 
                               ColorCount:number, Coloring:eColoring = eColoring.SemiHashed): Term[]{

    //>> [1]: EXTRACT TERMS FROM EQUATION
    let terms = ExtractTerms(Equation, Type, Offset);

    

    //>> [2]: COLOR TERMS DEPENDING ON THE REQUESTED COLORING
    if (Coloring === eColoring.Hashed){
        for (const term of terms){
            term.Color = (term.Hash % ColorCount + ColorCount) % ColorCount;
        }  
    }
    else if (Coloring === eColoring.Ordered   ){ ColorOrdered   (terms, ColorCount);}
    else if (Coloring === eColoring.SemiHashed){ ColorSemiHashed(terms, ColorCount);}


    //>> [5]: RETURN COLORED TERMS
    return terms;
}

function ExtractTerms(Equation:string, Type:eEquationType, Offset:number): Term[]{   

    //>> [1]: IF AUTO EQUATION TYPE THEN DETERMINE THE RIGHT TYPE
    if (Type === eEquationType.AutoSpaces){
    
        //>> [1.1]: INITIALLY DEFAULT TO NO SPACES
        Type = eEquationType.NoSpaces;

        //>> [1.2]: SWITCH IF SPACES FOUND IN ANY ARGUMENT / RESULT PART
        let parts = Equation.split(/,|->/); 
        for (const part of parts){ 
            if (part.trim().includes(' ')){
                Type = eEquationType.WithSpaces;
                break;
            }
        }   
        
        //>> [1.3]: IF STILL NO SPACES FOUND CHECK ALSO FOR OPENING PARENTIS (
        if (Type === eEquationType.NoSpaces && (Equation.includes('('))){
            Type = eEquationType.WithSpaces;   
        } 
    }



    //>> [2]: PICK APPROPRIATE REGEX (MATCH TERMS: CHARS/WORDS "..." AND SEPARATORS: ","  "->" )
    let termRegEx:RegExp;
    if (Type === eEquationType.NoSpaces) {termRegEx = RegExp(/\.{3}|\w|,|->/g);}
    else                                 {termRegEx = RegExp(/\.{3}|\w+|,|->/g);}
    

    let arg_TermsArr:Term[][] = [[]];
    let result_Terms  :Term[]   = [];

    let match:RegExpExecArray|null;
    let currentTerms = arg_TermsArr[0];


    //>> [3]: FOR ALL FOUND MATCHES 
    while ((match = termRegEx.exec(Equation))){

        //>> [3.1]: IF "," THEN MOVE TO COLLECTING NEXT ARGUMENT TERMS
        if (match[0] === "\,"){
            arg_TermsArr.push([]);
            currentTerms = arg_TermsArr[arg_TermsArr.length-1];
        }

        //>> [3.2]: ELSE IF "->" THEN MOVE TO COLLECTING RESULT TERMS
        else if (match[0] === "->"){
            currentTerms = result_Terms; 
        }

        //>> [3.3]: ELSE TREAT MATCH TEXT AS A TERM AND ADD TO THE CURRENT ARGUMENTS / RESULTS
        else {
            currentTerms.push(new Term(match.index + Offset, match[0]));
        }
    }


    //>> [4]: IF THERE ARE NO RESULTS RETURN FLATTENED TERM ARRAYS ELSE DETERMINE TERM STATES
    if (result_Terms.length === 0){
        return arg_TermsArr.flat(1);
    }
   



    //>> [5]: INITIALLY SET ARGUMENT TERMS STATE TO "REDUCED" (WILL BE CHANGED IF FOUND IN RESULTS)
    for (let arg_Terms of arg_TermsArr){
        for (let inT of arg_Terms){
            inT.State = eTermState.Reduced;
        }
    }
        

    //>> [6]: FOR EVERY RESULT TERM
    for (let resT of result_Terms){

        let foundTerms:Term[] = [];
        let inAllCount = 0;

        //>> [6.1]: CHECK IF IT APPEARS IN ANY OF THE ARGUMENT'S TERMS
        for (let arg_Terms of arg_TermsArr){

            let found = false;
            for (let inT of arg_Terms){
                if (inT.Text === resT.Text){
                    foundTerms.push(inT);
                    found = true;
                }  
            }  
            if (found) {inAllCount += 1;}
        }        

        //>> [6.2]: IF FOUND IN ALL ARGS (AND THERE ARE 2+ ARGS) SET FOUND TERMS AND RESULT STATE TO "IN ALL"
        if (arg_TermsArr.length > 1 && arg_TermsArr.length === inAllCount){
            for (let foundT of foundTerms){ 
                foundT.State = eTermState.InAll;
            }

            resT.State = eTermState.InAll;
        }

        //>> [6.3]: ELSE IF FOUND IN ANY ARGS THEN SET FOUND TERMS STATE BACK TO "NORMAL"
        else if (foundTerms.length > 0){ 
            for (let foundT of foundTerms){ 
                foundT.State = eTermState.Normal;
            }
        }

        //>> [6.4]: ELSE NO MATCHING ARGUMENT TERMS WERE FOUND SO SET RESULT TERM STATE TO "NEW"
        else {
            resT.State = eTermState.New;  
        }
    }


    //>> [7]: RETURN FLATTENED TERM ARRAY OF ALL ARGUMENTS AND RESULTS
    return arg_TermsArr.flat(1).concat(result_Terms);
}

function ColorOrdered(Terms:Term[], ColorCount:number){
    let colorMap = new Map<string, number>();
    let order = 0;

    //>> [1]: FOR ALL TERMS
    for (const term of Terms){
        let color = colorMap.get(term.Text);
        
        //>> [1.1]: IF TERMS ALREADY APPEARED THEN USE THE SAME COLOR FROM COLOR MAP
        if (color !== undefined){
            term.Color = color;
        }
        //>> [1.2]: ELSE PICK THE NEXT COLOR FOR THE TERM, ADDING IT TO THE COLOR MAP 
        else{
            term.Color = order;
            colorMap.set(term.Text, order);
            order = (order+1)%ColorCount;
        }
    }
}

function ColorSemiHashed(Terms:Term[], ColorCount:number){

    let colorMap = new Map<string, number>();
    let usedColors = Array.from({length:ColorCount},()=>false);

    //>> [1]: PASS 1: FOR ALL TERMS FIT ALL NON COLLIDING HASHES
    for (const term of Terms){
        let color = colorMap.get(term.Text);
        
        //>> [1.1]: IF TERMS ALREADY APPEARED THEN USE THE SAME COLOR FROM COLOR MAP
        if (color !== undefined){
            term.Color = color;
        }
        //>> [1.2]: ELSE GET COLOR FROM HASH AND IF IT IS STILL FREE THEN USE IT (ELSE SKIP)
        else{
            let color = (term.Hash % ColorCount + ColorCount) % ColorCount;

            if (usedColors[color]) {continue;}

            usedColors[color] = true;
            term.Color = color;
            colorMap.set(term.Text, color);
        }
    }

    //>> [2]: PASS 2: FOR ALL TERMS WITHOUT COLOR FIND A FREE COLOR
    for (const term of Terms){

        //>> [2.1]: SKIP ALREADY COLORED TERMS
        if (term.Color !== -1) {continue;}

        let color = colorMap.get(term.Text);
        
        //>> [2.2]: IF TERMS ALREADY APPEARED THEN USE THE SAME COLOR FROM COLOR MAP
        if (color !== undefined){
            term.Color = color;
        }
        //>> [2.3]: ELSE
        else{

            //>> [2.3.1]: GET COLOR FROM HASH
            let color = (term.Hash % ColorCount + ColorCount) % ColorCount;

            //>> [2.3.2]: IF COLOR IS NOT FREE THEN FIND THE NEXT FREE (IF ALL USED THEN RESET USED_COLORS)
            if (usedColors[color]){
                let foundFreeColor = -1;
                for (let i = 0; i < ColorCount; i++) {
                    let pos = (i+color)%ColorCount;
                    
                    if (!usedColors[pos]){
                        foundFreeColor = pos;
                        break;
                    }
                }

                if (foundFreeColor === -1){
                    usedColors = Array.from({length:ColorCount},()=>false); 
                } 
                else{
                    color = foundFreeColor;
                }
            }

            //>> [2.3.3]: USE THE SELECTED COLOR FOR THE TERM, ADDING IT TO THE COLOR MAP  
            usedColors[color] = true;
            term.Color = color;
            colorMap.set(term.Text, color);
        }
    }
}



function GenerateHash(str:string, seed = 9){
    
    let h = 9;

    for(let i=0; i < str.length; i++){
        h = Math.imul(h^(str.charCodeAt(i)+seed),9**9);
    }

    return h^h >>> 9;
}